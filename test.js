/**
 * Checks for the proof slice. Run: node test.js  (no install)
 * Asserts the four safety properties, including the hardened validation.
 */
'use strict';
const assert = require('assert');
const {
  buildContext, extractStatedNumbers, isValid, fallback, processNote,
  resolveApprover, callModel,
} = require('./index.js');

const record = {
  item: 'oat-milk-1l', display_name: '1L Oat Milk', on_hand: 42,
  reorder_point: 50, unit_cost: 1.37, supplier_contract_id: 'SC-9931',
};
const ctx = (note) => buildContext(note, record);

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok -', name); }

// [BOUNDARY] buildContext never leaks secrets
check('buildContext hides secrets', () => {
  const c = ctx('note');
  assert.strictEqual(c.unit_cost, undefined);
  assert.strictEqual(c.supplier_contract_id, undefined);
  assert.strictEqual(c.on_hand, undefined);
});

// [VALIDATE] valid restock with a stated number is accepted
check('isValid accepts a stated quantity', () => {
  const r = isValid(JSON.stringify({ item: 'oat-milk-1l', action: 'restock', quantity: 24 }), ctx('send 24 please'));
  assert.strictEqual(r.ok, true);
});

// [VALIDATE] invented quantity (not in the note) is rejected
check('isValid rejects an invented quantity', () => {
  const r = isValid(JSON.stringify({ item: 'oat-milk-1l', action: 'restock', quantity: 200 }), ctx('we are a bit short'));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /never stated|invented/);
});

// [VALIDATE] precise parsing: a decimal fragment is NOT a stated quantity
check('extractStatedNumbers ignores decimal fragments', () => {
  const nums = extractStatedNumbers('restock the 2.200 L bottles, 24 cases');
  assert.ok(nums.has(24), '24 is a stated whole number');
  assert.ok(!nums.has(200), '200 is only part of the decimal 2.200');
  assert.ok(!nums.has(2), '2 is only the integer part of 2.200');
});

check('isValid rejects a quantity that is only a decimal fragment', () => {
  const r = isValid(JSON.stringify({ item: 'oat-milk-1l', action: 'restock', quantity: 200 }), ctx('restock the 2.200 L bottles'));
  assert.strictEqual(r.ok, false);
});

// [VALIDATE] quantity range is enforced (max)
check('isValid rejects a quantity above the max', () => {
  const r = isValid(JSON.stringify({ item: 'oat-milk-1l', action: 'restock', quantity: 99999 }), ctx('send 99999'));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /out of range/);
});

// [VALIDATE] unexpected keys are rejected
check('isValid rejects unexpected keys', () => {
  const r = isValid(JSON.stringify({ item: 'oat-milk-1l', action: 'restock', quantity: 12, discount: 0.5 }), ctx('send 12'));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /unexpected key/);
});

// [VALIDATE] missing keys are rejected
check('isValid rejects missing keys', () => {
  const r = isValid(JSON.stringify({ item: 'oat-milk-1l', action: 'hold' }), ctx('x'));
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /missing key/);
});

// [VALIDATE] bad JSON / unknown action
check('isValid rejects non-JSON', () => assert.strictEqual(isValid('not json', ctx('x')).ok, false));
check('isValid rejects unknown action', () => {
  const r = isValid(JSON.stringify({ item: 'oat-milk-1l', action: 'delete', quantity: null }), ctx('x'));
  assert.strictEqual(r.ok, false);
});

// [FALLBACK] safe needs_review record
check('fallback returns a safe needs_review record', () => {
  const fb = fallback('vague note', 'invented quantity');
  assert.strictEqual(fb.status, 'needs_review');
  assert.strictEqual(fb.action, null);
  assert.strictEqual(fb.source, 'fallback');
});

// [FALLBACK] a THROWN model error uses the same fallback, never crashes
check('processNote catches a thrown model error', () => {
  const r = processNote('model timeout-sim on oat milk', record);
  assert.strictEqual(r.trusted, false);
  assert.match(r.staged.reason, /model error/);
});

// [BOUNDARY] approver check is not "any truthy string"
check('resolveApprover rejects an unknown/truthy string', () => {
  assert.strictEqual(resolveApprover('anybody'), null);
  assert.strictEqual(resolveApprover(''), null);
  assert.strictEqual(resolveApprover({ id: 'nope', role: 'buyer' }), null);
  const ok = resolveApprover('buyer@shelfscan');
  assert.ok(ok && ok.role === 'buyer');
});

// [SEPARATION] processNote never mutates the real record
check('processNote does not mutate real inventory', () => {
  const before = { ...record };
  processNote('we are a bit short, maybe more soon', record);
  assert.deepStrictEqual(record, before);
});

console.log(`\n${passed} checks passed.`);

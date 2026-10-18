/**
 * Minimal checks for the proof slice. Run: node test.js  (no install)
 * Asserts the four safety properties hold.
 */
'use strict';
const assert = require('assert');
const { buildContext, isValid, fallback, processNote } = require('./index.js');

const record = {
  item: 'oat-milk-1l', display_name: '1L Oat Milk', on_hand: 42,
  reorder_point: 50, unit_cost: 1.37, supplier_contract_id: 'SC-9931',
};

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok -', name); }

// [BOUNDARY] buildContext never leaks secrets
check('buildContext hides secrets', () => {
  const ctx = buildContext('note', record);
  assert.strictEqual(ctx.unit_cost, undefined);
  assert.strictEqual(ctx.supplier_contract_id, undefined);
  assert.strictEqual(ctx.on_hand, undefined);
});

// [VALIDATE] valid restock with a stated number is accepted
check('isValid accepts a stated quantity', () => {
  const ctx = buildContext('send 24 please', record);
  const r = isValid(JSON.stringify({ item: 'oat-milk-1l', action: 'restock', quantity: 24 }), ctx);
  assert.strictEqual(r.ok, true);
});

// [VALIDATE] invented quantity (not in the note) is rejected
check('isValid rejects an invented quantity', () => {
  const ctx = buildContext('we are a bit short', record);
  const r = isValid(JSON.stringify({ item: 'oat-milk-1l', action: 'restock', quantity: 200 }), ctx);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /invented|never stated/);
});

// [VALIDATE] bad JSON rejected
check('isValid rejects non-JSON', () => {
  const ctx = buildContext('x', record);
  assert.strictEqual(isValid('not json', ctx).ok, false);
});

// [VALIDATE] bad enum rejected
check('isValid rejects unknown action', () => {
  const ctx = buildContext('x', record);
  const r = isValid(JSON.stringify({ item: 'oat-milk-1l', action: 'delete', quantity: null }), ctx);
  assert.strictEqual(r.ok, false);
});

// [FALLBACK] produces a safe needs_review record, never throws
check('fallback returns a safe needs_review record', () => {
  const fb = fallback('vague note', 'invented quantity');
  assert.strictEqual(fb.status, 'needs_review');
  assert.strictEqual(fb.action, null);
  assert.strictEqual(fb.source, 'fallback');
});

// [SEPARATION] processNote never mutates the real record
check('processNote does not mutate real inventory', () => {
  const before = { ...record };
  processNote('we are a bit short, maybe more soon', record);
  assert.deepStrictEqual(record, before);
});

console.log(`\n${passed} checks passed.`);

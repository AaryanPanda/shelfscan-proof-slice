/**
 * ShelfScan — AI Integration Proof Slice
 * ----------------------------------------------------------------------------
 * The smallest end-to-end slice of a safe AI feature.
 *
 * Feature: a supplier sends a free-text note ("running low on 1L oat milk,
 * send a fresh batch"). The model SUGGESTS a structured restock instruction.
 * Our code then CHECKS it, FALLS BACK when it's invalid or the model throws,
 * and NEVER lets the model touch real inventory — the suggestion is staged for
 * human approval.
 *
 * Run:  node index.js        (no install, no API key — the model is mocked)
 *
 * The four things this slice proves, each labelled in the code below:
 *   [BOUNDARY]   what the model decides vs. what our app decides
 *   [VALIDATE]   we check the model's output before trusting it
 *   [FALLBACK]   invalid/failed/thrown output is handled safely
 *   [SEPARATION] AI output is staged, not written over real data
 * ----------------------------------------------------------------------------
 */

'use strict';

// ---------------------------------------------------------------------------
// REAL DATA (the protected system of record). The model must NEVER write here
// directly. It also contains fields the model must never see (cost, supplier
// contract id, on_hand) — see buildContext().
// ---------------------------------------------------------------------------
const inventory = {
  'oat-milk-1l': {
    item: 'oat-milk-1l',
    display_name: '1L Oat Milk',
    on_hand: 42,
    reorder_point: 50,
    unit_cost: 1.37,                 // SECRET-ish: never sent to the model
    supplier_contract_id: 'SC-9931', // SECRET: never sent to the model
  },
};

// A staging area, completely separate from `inventory`. Suggestions land here
// and wait for a human to approve them. [SEPARATION]
const pendingSuggestions = [];

// --- Contract constants (a clearly defined, checkable schema) ---------------
const ALLOWED_ACTIONS = ['restock', 'discontinue', 'hold'];
const EXPECTED_KEYS = ['item', 'action', 'quantity']; // exactly these, no more
const QUANTITY_MIN = 1;
const QUANTITY_MAX = 10000;          // a single supplier restock can't exceed this

// Known human approvers (an allow-list). A real app would check an auth/role
// service; here it is an explicit table so "any truthy string" can't approve.
const APPROVERS = {
  'buyer@shelfscan': { id: 'buyer@shelfscan', role: 'buyer' },
  'lead@shelfscan': { id: 'lead@shelfscan', role: 'lead' },
};
const APPROVER_ROLES = ['buyer', 'lead'];

// ===========================================================================
// 1. buildContext() — choose which fields the model may see (NO secrets).
//    [BOUNDARY] The model only sees what it needs to parse the note; it never
//    sees unit_cost, supplier_contract_id, or on_hand.
// ===========================================================================
function buildContext(note, record) {
  return {
    note,                                  // the free text to parse
    known_item: record.item,               // so it can confirm the item id
    known_display_name: record.display_name,
    // deliberately NOT included: unit_cost, supplier_contract_id, on_hand.
  };
}

// ---------------------------------------------------------------------------
// extractStatedNumbers() — precise note parsing. Return the set of standalone
// integers actually written in the note, WITHOUT being fooled by decimals
// ("2.200"), thousands separators, or numbers glued to other tokens ("v200").
// A quantity is "stated" only if it is one of these whole-number tokens.
// ---------------------------------------------------------------------------
function extractStatedNumbers(note) {
  const nums = new Set();
  // Match integer tokens that are NOT part of a decimal and NOT glued to
  // letters/other digits: optional thousands separators, but reject a following
  // ".digit" (decimal) or an adjacent alphanumeric.
  const re = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(?![\d.])/g;
  let m;
  while ((m = re.exec(note)) !== null) {
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    if (Number.isInteger(n)) nums.add(n);
  }
  return nums;
}

// ===========================================================================
// MODEL (mocked). Stands in for the LLM call. Returns a SUGGESTION only.
//    [BOUNDARY] The model decides: item / action / quantity. That's all.
//    It returns data; it performs no writes. We include deliberately-bad
//    outputs so validation + fallback actually fire.
// ===========================================================================
function callModel(context) {
  const n = context.note.toLowerCase();

  // Simulated infrastructure failure: the model call THROWS. [FALLBACK via try/catch]
  if (n.includes('timeout-sim')) {
    throw new Error('model call timed out');
  }
  // Vague note: the model invents 200 though the note gives no amount. [VALIDATE catches]
  if (n.includes('a bit short') || n.includes('maybe')) {
    return JSON.stringify({ item: context.known_item, action: 'restock', quantity: 200 });
  }
  // Decimal trap: note says "2.200 L bottles", model claims quantity 200 — 200
  // is only part of a decimal, never a stated count. [precise parsing catches]
  if (n.includes('2.200')) {
    return JSON.stringify({ item: context.known_item, action: 'restock', quantity: 200 });
  }
  // Absurd amount: model returns a quantity far above the max. [range catches]
  if (n.includes('a lot')) {
    return JSON.stringify({ item: context.known_item, action: 'restock', quantity: 99999 });
  }
  // Extra-field injection: model adds an unexpected key. [unknown-key catches]
  if (n.includes('extra-sim')) {
    return JSON.stringify({ item: context.known_item, action: 'restock', quantity: 12, discount: 0.5 });
  }
  // Total garbage: non-JSON. [FALLBACK catches]
  if (n.includes('???')) {
    return 'Sure! You should probably restock that soon.';
  }
  // Well-formed note with an explicit amount.
  if (n.includes('send') && n.includes('batch')) {
    return JSON.stringify({ item: context.known_item, action: 'restock', quantity: 24 });
  }
  // Explicit discontinue, no quantity needed.
  if (n.includes('stop stocking') || n.includes('discontinue')) {
    return JSON.stringify({ item: context.known_item, action: 'discontinue', quantity: null });
  }
  // Default: nothing actionable.
  return JSON.stringify({ item: context.known_item, action: 'hold', quantity: null });
}

// ===========================================================================
// 2. isValid(answer) — check the output BEFORE trusting it. [VALIDATE]
//    Returns { ok: true, value } or { ok: false, reason }.
//    Rejects: bad JSON, wrong shape, UNEXPECTED KEYS, unknown item/action,
//    out-of-range quantity, and any restock quantity NOT actually stated in the
//    note (using precise number parsing, not a loose regex).
// ===========================================================================
function isValid(rawAnswer, context) {
  // a) must be a string that parses to JSON
  if (typeof rawAnswer !== 'string') {
    return { ok: false, reason: 'model output is not a string' };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawAnswer);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }

  // b) must be a plain object (not array/null)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'not a JSON object' };
  }

  // c) strict shape — reject any key we did not ask for, and require all expected
  const keys = Object.keys(parsed);
  const unexpected = keys.filter((k) => !EXPECTED_KEYS.includes(k));
  if (unexpected.length > 0) {
    return { ok: false, reason: `unexpected key(s): ${unexpected.join(', ')}` };
  }
  const missing = EXPECTED_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    return { ok: false, reason: `missing key(s): ${missing.join(', ')}` };
  }

  // d) item + action enum
  if (parsed.item !== context.known_item) {
    return { ok: false, reason: `item "${parsed.item}" is not the known item` };
  }
  if (!ALLOWED_ACTIONS.includes(parsed.action)) {
    return { ok: false, reason: `action "${parsed.action}" not in ${ALLOWED_ACTIONS.join('|')}` };
  }

  // e) quantity rules
  if (parsed.action === 'restock') {
    // must be an integer in the allowed range...
    if (!Number.isInteger(parsed.quantity)) {
      return { ok: false, reason: 'restock quantity must be an integer' };
    }
    if (parsed.quantity < QUANTITY_MIN || parsed.quantity > QUANTITY_MAX) {
      return { ok: false, reason: `quantity ${parsed.quantity} out of range [${QUANTITY_MIN}, ${QUANTITY_MAX}]` };
    }
    // ...and must be a number ACTUALLY stated in the note (precise parse).
    const stated = extractStatedNumbers(context.note);
    if (!stated.has(parsed.quantity)) {
      return { ok: false, reason: `quantity ${parsed.quantity} was never stated in the note (invented)` };
    }
  } else {
    // discontinue / hold: quantity must be explicitly null
    if (parsed.quantity !== null) {
      return { ok: false, reason: `quantity must be null for action "${parsed.action}"` };
    }
  }

  return { ok: true, value: parsed };
}

// ===========================================================================
// 3. fallback() — what happens when the model fails or is invalid. [FALLBACK]
//    We do NOT guess and we do NOT touch inventory. We stage a safe, explicit
//    "needs human review" record instead.
// ===========================================================================
function fallback(note, reason) {
  return {
    status: 'needs_review',
    item: null,
    action: null,
    quantity: null,
    note,
    reason,                 // why the model output was not trusted
    source: 'fallback',
  };
}

// ---------------------------------------------------------------------------
// stageSuggestion() — the ONLY way an AI result enters the system, and it goes
//    into the staging area, never into `inventory`. A human approves later.
//    [SEPARATION]
// ---------------------------------------------------------------------------
function stageSuggestion(suggestion) {
  pendingSuggestions.push({ ...suggestion, staged_at: new Date().toISOString(), approved: false });
}

// ---------------------------------------------------------------------------
// resolveApprover() — accept only a known approver with an approving role.
//    Not "any truthy string": we take an id or an {id, role} object, look it up
//    in the APPROVERS allow-list, and require an approving role. [BOUNDARY]
// ---------------------------------------------------------------------------
function resolveApprover(approver) {
  const id = typeof approver === 'string' ? approver : approver && approver.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  const record = APPROVERS[id];
  if (!record || !APPROVER_ROLES.includes(record.role)) return null;
  return record;
}

// Applying to real inventory requires an explicit, authorised human approver.
// The AI can never call this on its own. [BOUNDARY + SEPARATION]
function approveAndApply(index, approver) {
  const s = pendingSuggestions[index];
  if (!s || s.status !== 'ok') throw new Error('nothing valid to apply at that index');
  const human = resolveApprover(approver);
  if (!human) throw new Error('approval requires a known approver with an approving role');
  // (In a real app this would update on_hand / create a PO. Shown as a gated
  // write to demonstrate it is behind a human; inventory itself is untouched here.)
  s.approved = true;
  s.approved_by = human.id;
  s.approved_role = human.role;
  return `APPLIED by ${human.id} (${human.role}): ${s.action} ${s.quantity ?? ''} ${s.item}`.replace(/\s+/g, ' ').trim();
}

// ===========================================================================
// The end-to-end slice: note -> context -> model -> validate -> (stage | fallback)
//    The model call is wrapped so a THROWN failure uses the same fallback.
// ===========================================================================
function processNote(note, record) {
  const context = buildContext(note, record);     // [BOUNDARY] no secrets in

  let rawAnswer;
  try {
    rawAnswer = callModel(context);               // model SUGGESTS (may throw)
  } catch (err) {
    const fb = fallback(note, `model error: ${err.message}`); // [FALLBACK]
    stageSuggestion(fb);
    return { trusted: false, staged: fb };
  }

  const check = isValid(rawAnswer, context);       // [VALIDATE] before trusting
  if (!check.ok) {
    const fb = fallback(note, check.reason);       // [FALLBACK] safe path
    stageSuggestion(fb);                            // staged, not applied
    return { trusted: false, staged: fb };
  }

  const suggestion = { status: 'ok', ...check.value, note, source: 'model' };
  stageSuggestion(suggestion);                      // [SEPARATION] staged only
  return { trusted: true, staged: suggestion };
}

// ---------------------------------------------------------------------------
// DEMO — run the slice over a range of notes and print what happened.
// ---------------------------------------------------------------------------
function demo() {
  const record = inventory['oat-milk-1l'];
  const notes = [
    'running low on the 1L oat milk, please send 24 in a fresh batch', // valid
    "we're a bit short on oat milk, maybe get some more soon",          // invented qty
    'restock the 2.200 L oat milk bottles',                            // decimal trap
    'we need a lot of oat milk',                                       // over max
    'oat milk extra-sim please send 12',                              // unexpected key
    'oat milk ??? just sort it out',                                   // not JSON
    'model timeout-sim on oat milk',                                  // model throws
    'please stop stocking the 1L oat milk',                           // discontinue
  ];

  console.log('=== ShelfScan proof slice ===\n');
  notes.forEach((note, i) => {
    const r = processNote(note, record);
    console.log(`Note ${i + 1}: "${note}"`);
    if (r.trusted) {
      console.log(`  -> TRUSTED  : ${r.staged.action} ${r.staged.quantity ?? ''}`.trimEnd());
      console.log('     staged for approval (real inventory untouched)');
    } else {
      console.log(`  -> REJECTED : ${r.staged.reason}`);
      console.log('     fallback staged as needs_review (no guess, no write)');
    }
    console.log('');
  });

  console.log('--- real inventory on_hand (unchanged by the AI):',
    inventory['oat-milk-1l'].on_hand, '---');
  console.log('--- secrets never sent to the model: unit_cost, supplier_contract_id ---\n');

  // Approval: only a known approver with an approving role can apply. [BOUNDARY]
  const firstValid = pendingSuggestions.findIndex((s) => s.status === 'ok');
  console.log('Human approval of suggestion #' + firstValid + ':');
  try {
    console.log('  reject "anybody":', approveAndApply(firstValid, 'anybody'));
  } catch (e) {
    console.log('  reject "anybody": BLOCKED —', e.message);
  }
  console.log('  ', approveAndApply(firstValid, 'buyer@shelfscan'));
}

if (require.main === module) demo();

module.exports = {
  buildContext, extractStatedNumbers, callModel, isValid, fallback,
  processNote, resolveApprover, approveAndApply,
};

/**
 * ShelfScan — AI Integration Proof Slice
 * ----------------------------------------------------------------------------
 * The smallest end-to-end slice of a safe AI feature.
 *
 * Feature: a supplier sends a free-text note ("running low on 1L oat milk,
 * send a fresh batch"). The model SUGGESTS a structured restock instruction.
 * Our code then CHECKS it, FALLS BACK when it's invalid, and NEVER lets the
 * model touch real inventory — the suggestion is staged for human approval.
 *
 * Run:  node index.js        (no install, no API key — the model is mocked)
 *
 * The four things this slice proves, each labelled in the code below:
 *   [BOUNDARY]   what the model decides vs. what our app decides
 *   [VALIDATE]   we check the model's output before trusting it
 *   [FALLBACK]   invalid/failed output is handled safely, never crashes the flow
 *   [SEPARATION] AI output is staged, not written over real data
 * ----------------------------------------------------------------------------
 */

'use strict';

// ---------------------------------------------------------------------------
// REAL DATA (the protected system of record). The model must NEVER write here
// directly. It also contains fields the model must never see (cost, supplier
// contract id) — see buildContext().
// ---------------------------------------------------------------------------
const inventory = {
  'oat-milk-1l': {
    item: 'oat-milk-1l',
    display_name: '1L Oat Milk',
    on_hand: 42,
    reorder_point: 50,
    unit_cost: 1.37,            // SECRET-ish: never sent to the model
    supplier_contract_id: 'SC-9931', // SECRET: never sent to the model
  },
};

// A staging area, completely separate from `inventory`. Suggestions land here
// and wait for a human to approve them. [SEPARATION]
const pendingSuggestions = [];

const ALLOWED_ACTIONS = ['restock', 'discontinue', 'hold'];

// ===========================================================================
// 1. buildContext() — choose which fields the model may see (NO secrets).
//    [BOUNDARY] The model only sees what it needs to parse the note; it never
//    sees unit_cost or supplier_contract_id.
// ===========================================================================
function buildContext(note, record) {
  return {
    note,                                  // the free text to parse
    known_item: record.item,               // so it can confirm the item id
    known_display_name: record.display_name,
    // deliberately NOT included: unit_cost, supplier_contract_id, on_hand.
  };
}

// ===========================================================================
// MODEL (mocked). Stands in for the LLM call. Returns a SUGGESTION only.
//    [BOUNDARY] The model decides: item / action / quantity. That's all.
//    It returns data; it performs no writes.
//    We include a couple of deliberately-bad outputs to prove validation +
//    fallback actually fire (an invented quantity, and malformed JSON).
// ===========================================================================
function callModel(context) {
  const n = context.note.toLowerCase();

  // Simulated "vague note" failure mode: the real bug this guards against is
  // the model inventing a specific quantity the note never stated.
  if (n.includes('a bit short') || n.includes('maybe')) {
    // The model invents 200 even though the note gives no amount. [VALIDATE catches this]
    return JSON.stringify({ item: context.known_item, action: 'restock', quantity: 200 });
  }
  // Simulated total failure: model returns non-JSON garbage. [FALLBACK catches this]
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
//    Crucially: a quantity the note never stated is rejected (the invented-
//    number bug), and anything off-shape is rejected.
// ===========================================================================
function isValid(rawAnswer, context) {
  // a) must be parseable JSON
  let parsed;
  try {
    parsed = JSON.parse(rawAnswer);
  } catch {
    return { ok: false, reason: 'not valid JSON' };
  }

  // b) shape + enum checks
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: 'not an object' };
  }
  if (parsed.item !== context.known_item) {
    return { ok: false, reason: `item "${parsed.item}" is not the known item` };
  }
  if (!ALLOWED_ACTIONS.includes(parsed.action)) {
    return { ok: false, reason: `action "${parsed.action}" not in ${ALLOWED_ACTIONS.join('|')}` };
  }

  // c) quantity rules
  //    - for restock: must be a positive integer AND that number must actually
  //      appear in the note (guards against the invented-quantity bug).
  //    - for discontinue/hold: quantity must be null.
  if (parsed.action === 'restock') {
    if (!Number.isInteger(parsed.quantity) || parsed.quantity <= 0) {
      return { ok: false, reason: 'restock quantity must be a positive integer' };
    }
    const noteHasNumber = new RegExp(`\\b${parsed.quantity}\\b`).test(context.note);
    if (!noteHasNumber) {
      return { ok: false, reason: `quantity ${parsed.quantity} was never stated in the note (invented)` };
    }
  } else {
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

// ===========================================================================
// stageSuggestion() — the ONLY way an AI result enters the system, and it goes
//    into the staging area, never into `inventory`. A human approves later.
//    [SEPARATION]
// ===========================================================================
function stageSuggestion(suggestion) {
  pendingSuggestions.push({ ...suggestion, staged_at: new Date().toISOString(), approved: false });
}

// Applying to real inventory requires an explicit human approval step. The AI
// can never call this on its own. [BOUNDARY + SEPARATION]
function approveAndApply(index, humanApprover) {
  const s = pendingSuggestions[index];
  if (!s || s.status !== 'ok') throw new Error('nothing valid to apply');
  if (!humanApprover) throw new Error('approval requires a human approver');
  // (In a real app this would update on_hand / create a PO. Shown as a no-op
  // write to demonstrate it is gated behind a human.)
  s.approved = true;
  s.approved_by = humanApprover;
  return `APPLIED by ${humanApprover}: ${s.action} ${s.quantity ?? ''} ${s.item}`.trim();
}

// ===========================================================================
// The end-to-end slice: note -> context -> model -> validate -> (stage | fallback)
// ===========================================================================
function processNote(note, record) {
  const context = buildContext(note, record);     // [BOUNDARY] no secrets in
  const rawAnswer = callModel(context);            // model SUGGESTS
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
// DEMO — run the slice over a few notes and print what happened.
// ---------------------------------------------------------------------------
function demo() {
  const record = inventory['oat-milk-1l'];
  const notes = [
    'running low on the 1L oat milk, please send 24 in a fresh batch',   // valid
    "we're a bit short on oat milk, maybe get some more soon",            // vague -> invented qty
    'oat milk ??? just sort it out',                                      // garbage -> not JSON
    'please stop stocking the 1L oat milk',                               // discontinue
  ];

  console.log('=== ShelfScan proof slice ===\n');
  notes.forEach((note, i) => {
    const r = processNote(note, record);
    console.log(`Note ${i + 1}: "${note}"`);
    if (r.trusted) {
      console.log(`  -> TRUSTED  : ${r.staged.action} ${r.staged.quantity ?? ''}`.trimEnd());
      console.log(`     staged for approval (real inventory untouched)`);
    } else {
      console.log(`  -> REJECTED : ${r.staged.reason}`);
      console.log(`     fallback staged as needs_review (no guess, no write)`);
    }
    console.log('');
  });

  // Prove the AI never changed real data on its own.
  console.log('--- real inventory on_hand (unchanged by the AI):',
    inventory['oat-milk-1l'].on_hand, '---');
  console.log('--- secrets never sent to the model: unit_cost, supplier_contract_id ---\n');

  // Human approval step — only a valid, staged suggestion can be applied, and
  // only by a human. [BOUNDARY]
  const firstValid = pendingSuggestions.findIndex((s) => s.status === 'ok');
  console.log('Human approves suggestion #' + firstValid + ':');
  console.log('  ', approveAndApply(firstValid, 'buyer@shelfscan'));
}

if (require.main === module) demo();

module.exports = { buildContext, callModel, isValid, fallback, processNote, approveAndApply };

# ShelfScan — AI Integration Proof Slice (Option A)

The smallest end-to-end slice of a **safe** AI feature: a supplier sends a
free-text note, the model *suggests* a structured restock instruction, our code
*checks* it, *falls back* when it's invalid, and the AI output is kept *separate*
from real inventory (a human approves before anything is applied).

## Run it

```bash
node index.js      # no install, no API key — the model is mocked
node test.js       # 7 assertions for the four safety properties
```

## The feature

Note in → structured instruction out:

```json
{ "item": "...", "action": "restock|discontinue|hold", "quantity": <number or null> }
```

The production bug this slice guards against: on a vague note ("we're a bit
short, maybe get more soon") the model invents a specific quantity the note
never stated, and buyers over-order. Our validation rejects any quantity that
does not actually appear in the note.

## How the slice shows each required property

| Requirement | Where | What it does |
|---|---|---|
| **Boundary** — model decides vs. app decides | `buildContext()`, `callModel()`, `approveAndApply()` | The model only *suggests* `item` / `action` / `quantity`. It performs no writes. Applying to real inventory is gated behind an explicit human approver. |
| **Validation** before trusting output | `isValid()`, `extractStatedNumbers()` | Strict checks: parseable JSON → plain object → **no unexpected keys and no missing keys** → known item → allowed action → quantity rules. For `restock`, the quantity must be an integer **within a defined range `[1, 10000]`** and must be a number **actually stated in the note**, matched by precise parsing that ignores decimal fragments (`2.200` ≠ `200`) and numbers glued to other tokens. `discontinue`/`hold` require `null`. |
| **Fallback** for failure/invalid output | `fallback()`, `processNote()` try/catch | On any validation failure **or a thrown model error** (the `callModel` call is wrapped), the slice does not guess and does not write; it stages a safe `needs_review` record carrying the reason. |
| **Separation** — AI output kept off real data | `pendingSuggestions` vs `inventory`, `stageSuggestion()`, `resolveApprover()` | Every AI result (valid or fallback) lands in a separate staging area. `inventory` is never written by the model — `node index.js` prints `on_hand` unchanged. Applying a suggestion requires a **known approver with an approving role** (`resolveApprover()` checks an allow-list) — not "any truthy string". |

## Hardening (from review feedback)
- **Unexpected / missing keys** rejected — the output must have exactly `item`, `action`, `quantity`.
- **Quantity range** `[1, 10000]` enforced — no unbounded quantities.
- **Precise note parsing** (`extractStatedNumbers`) — a quantity counts as "stated" only if it is a standalone whole number in the note; `200` inside `2.200`, or glued numbers, no longer count.
- **Thrown model errors** caught in `processNote` and routed through the same `fallback`.
- **Approver check** is an allow-list + role check, not a truthy test.

## Secrets

`buildContext()` deliberately omits `unit_cost` and `supplier_contract_id` (and
`on_hand`) — the model only ever sees the note and the item id/name. The test
`buildContext hides secrets` asserts this.

## Example output

```
Note 2: "we're a bit short on oat milk, maybe get some more soon"
  -> REJECTED : quantity 200 was never stated in the note (invented)
     fallback staged as needs_review (no guess, no write)
...
--- real inventory on_hand (unchanged by the AI): 42 ---
Human approves suggestion #0:
   APPLIED by buyer@shelfscan: restock 24 oat-milk-1l
```

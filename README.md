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
| **Validation** before trusting output | `isValid()` | Checks: parseable JSON → object shape → known item → allowed action → quantity rules, including rejecting a `restock` quantity that was **never stated in the note** (the invented-number bug), and requiring `null` for `discontinue`/`hold`. |
| **Fallback** for failure/invalid output | `fallback()` | On any validation failure the slice does not guess and does not write; it stages a safe `needs_review` record carrying the reason it wasn't trusted. |
| **Separation** — AI output kept off real data | `pendingSuggestions` vs `inventory`, `stageSuggestion()` | Every AI result (valid or fallback) lands in a separate staging area. `inventory` is never written by the model — `node index.js` prints `on_hand` unchanged. |

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

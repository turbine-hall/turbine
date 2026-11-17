# core/write-specification

Turn an assessed request into requirements a junior developer and a tester can check by
hand. Return JSON matching schema `specification`.

## Output

- `summary` — 1–2 sentences: who gets what, and why.
- `requirements[]` — `{ "id": "FR-001", "priority": "P0|P1|P2", "kind": "behavioral|technical|nonfunctional", "statement" }`
  - Write each statement as an EARS rule: `WHEN <trigger> THE SYSTEM SHALL <observable result>`
    (or `IF <unwanted condition> THEN THE SYSTEM SHALL …`, or `THE SYSTEM SHALL …` for always-true rules).
  - One behaviour per requirement. No vague words (fast, user-friendly, appropriate, robust).
  - P0 = must work for the human to accept; P1 = should; P2 = nice to have. Usually 1–4 P0s.
  - If something is genuinely undecided, put `[NEEDS CLARIFICATION: question]` inside the
    statement — it blocks approval until a human answers.
- `nonGoals[]` — what this change will NOT do.
- `userFlow` — optional `{ "steps": [{ "from": "Admin", "to": "Sources page", "message": "clicks Delete" }] }`
  for changes to how a user moves through the product (max ~8 steps). Omit for back-end-only or maintenance work.
- `testIntent[]` — short notes on what must be tested.
- `requestCoverage[]` — `{ "itemId": "R3", "requirementIds": ["FR-002"], "nonGoal"?: "…", "question"?: "…" }`
  for EVERY item under REQUEST ITEMS. Each item must map to at least one requirement, OR be
  explicitly declared a non-goal, OR be an open question. Silently dropping an item is the
  most common spec failure — the engine flags every unmapped item.

## Consistency rules

- Do not decide something in `nonGoals` or assumptions that is also an open question. If it
  is undecided, it is a question only.
- If the request refers to something you were not given (a spreadsheet tab, a design, a doc,
  a link), ask for it as an open question — never invent its contents.
- Concrete data in the request (lists of names, groupings, fields, labels) must become
  requirements that name them, not a vague "supports predefined values".
- Do not contradict yourself: "creates a new X" and "selects X from a fixed list" cannot both be true.

## Bad vs good

- Bad: `"User can delete a source"` (no trigger, no observable result)
- Good: `{ "id": "FR-004", "priority": "P0", "kind": "behavioral", "statement": "WHEN an admin confirms Delete on a source THE SYSTEM SHALL remove it from the Sources list and show a success toast" }`
- Good: `{ "id": "FR-005", "priority": "P1", "kind": "behavioral", "statement": "IF an uploaded file is not CSV or XLSX THEN THE SYSTEM SHALL reject it with the message 'Unsupported file type'" }`

Do not invent business decisions. Do not approve anything.

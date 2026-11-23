# core/plan-change

Plan the implementation of approved requirements. Return JSON matching schema `plan`.
The engine writes `PLAN.md` from this output and checks that every requirement is covered.
Also follow **core/plan-executive-summary** (concatenated in the same call) for `executiveSummary` and `diagrams`.

## Output

- `summary` — 1–2 sentences (also used as the short pointer in SPEC.md).
- `architecture` — how components/modules interact after the change (omit only if truly N/A; say why).
- `dataModel` — schema / store / migration / persistence impact (omit only if none; say "no data model change").
- `interfaces` — APIs, CLI, events, or package exports that change (omit only if none; say "no interface change").
- `steps[]` — `{ "id": "S1", "description", "requirementIds": ["FR-001"], "files": ["src/…"] }`
  - Every requirement ID must appear in at least one step. Every step links to at least one requirement
    (a step with none looks like scope creep).
  - `files`: the files or folders you expect to change, from the TASK_CONTEXT files (each has a stated reason) when possible.
    TASK_CONTEXT is a selection, not a complete list: a file that is not in it may still need to change.
  - Use only repositories listed under REPOSITORIES IN SCOPE; prefix other-repo paths with `<repo>:`.
  - 3–8 steps for normal work; fewer for trivial changes.
- `testPlan[]` — `{ "requirementId": "FR-001", "test": "what the test proves", "kind": "unit|api|e2e|manual" }`.
  Every P0 requirement needs at least one test.
- `risks[]` — `{ "risk", "mitigation" }`. Name new dependencies here (the engine flags unplanned ones).
- `estimatedComplexity` — `low` | `medium` | `high`.
- `codingAgentTokenEstimate` — **heuristic** budget for the *coding* agent that will implement this plan (not billed cost, not this planning call):
  ```
  {
    "totalTokens": <number>,
    "inputTokens": <number>,   // optional split
    "outputTokens": <number>,  // optional split
    "basis": "one line: how you derived the numbers",
    "confidence": "estimated"
  }
  ```
  **Heuristic (use this; do not invent provider invoices):**
  - Base by `estimatedComplexity`: low = 50_000, medium = 150_000, high = 400_000 total tokens.
  - Add `15_000 ×` number of steps.
  - Add `5_000 ×` number of distinct files listed across steps.
  - Split roughly 70% input / 30% output when you fill the optional fields.
  - Always set `confidence` to exactly `"estimated"`. Never claim actual or billed usage.

## Bad vs good

- Bad step: `"Review existing UI and APIs"` (no requirement, no files)
- Good step: `{ "id": "S2", "description": "Add confirm dialog and call deleteSourceAction", "requirementIds": ["FR-004"], "files": ["src/components/admin/linkedin/sources-desk.tsx"] }`

Do not invent business decisions. Do not approve anything.

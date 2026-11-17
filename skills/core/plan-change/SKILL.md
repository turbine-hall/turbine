# core/plan-change

Plan the implementation of approved requirements. Return JSON matching schema `plan`.
The plan is shown as a table; the engine checks that every requirement is covered.

## Output

- `summary` — 1–2 sentences.
- `steps[]` — `{ "id": "S1", "description", "requirementIds": ["FR-001"], "files": ["src/…"] }`
  - Every requirement ID must appear in at least one step. Every step links to at least one requirement
    (a step with none looks like scope creep).
  - `files`: the files or folders you expect to change, from PROJECT_EVIDENCE related files when possible.
  - Use only repositories listed under REPOSITORIES IN SCOPE; prefix other-repo paths with `<repo>:`.
  - 3–8 steps for normal work; fewer for trivial changes.
- `testPlan[]` — `{ "requirementId": "FR-001", "test": "what the test proves", "kind": "unit|api|e2e|manual" }`.
  Every P0 requirement needs at least one test.
- `risks[]` — `{ "risk", "mitigation" }`. Name new dependencies here (the engine flags unplanned ones).
- `estimatedComplexity` — low | medium | high, with a one-line reason.

## Bad vs good

- Bad step: `"Review existing UI and APIs"` (no requirement, no files)
- Good step: `{ "id": "S2", "description": "Add confirm dialog and call deleteSourceAction", "requirementIds": ["FR-004"], "files": ["src/components/admin/linkedin/sources-desk.tsx"] }`

Do not invent business decisions. Do not approve anything.

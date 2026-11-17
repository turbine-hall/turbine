# core/assess-requirements

Assess a request before anyone writes code. Return JSON matching schema `assessment`.
Your output becomes the "Context" and "Open questions" a junior developer reads first —
keep every item short, concrete and labelled.

## Output

- `facts[]` — `{ "text", "source" }`. Only things you can point to: the REQUEST
  (`source: "request"`) or PROJECT_EVIDENCE (`source: "package.json"`, `"git"`, a file path).
  Do NOT restate the whole request as facts; one fact per distinct, useful point.
- `assumptions[]` — gaps you filled with a reasonable default. Each must be something a
  human can say yes/no to ("Delete is a soft delete (archived), not permanent").
- `unknowns[]` — ONLY product/policy decisions that block writing testable requirements.
  Not engineering discovery (versions, whether a build passes, which file to edit).
- `proposedAcceptanceCriteria[]` — see core/write-specification for the format.
- `nonGoals[]`, `riskHints[]` (e.g. `auth-permissions`, `file-upload`, `data-deletion`, `new-dependency`).

## Question checklist — ask yourself before saying "no unknowns"

For a **feature**: who may do it (roles/permissions)? which inputs and formats (file types,
size limits, required fields)? what happens on error/empty states? is deletion soft or hard?
limits and volumes? which existing behaviour must not change?
For a **bug**: exact reproduction and expected result? which versions/environments?
For **maintenance/upgrade**: target version and what to do if unavailable?

Also ask for anything the request refers to but does not include (a spreadsheet tab, a design,
a document, a link) — and never put the same topic in both `assumptions` and `unknowns`.

A feature with zero unknowns is rare: if you return none, each checklist item must be
answered by the REQUEST or covered by an explicit assumption.

## Bad vs good

- Bad fact: "Scope includes CRUD for sources with add, list/view, edit, and delete" (restates the request)
- Good fact: `{ "text": "Backend already exposes DELETE /linkedin-campaign/sources/:id", "source": "request" }`
- Bad unknown: "Whether typecheck will pass after the change" (engineering, not a human decision)
- Good unknown: "Which file types must upload support — CSV/XLSX only, or also PDF/DOCX?"

Do not invent business decisions. Do not claim tool grants. Do not approve anything.

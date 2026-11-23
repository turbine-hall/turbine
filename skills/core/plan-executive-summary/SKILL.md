# core/plan-executive-summary

Produce the human-facing executive view of the same plan JSON (schema `plan`).
The engine renders this as `EXECUTIVE-SUMMARY.md`. This skill runs in the **same** model call as
`core/plan-change` — add these fields to the single plan object; do not return a second document.

## Output fields

- `executiveSummary` — 2–5 short paragraphs (or tight bullets) a non-implementer can read to understand
  what will change, why, and what stays out of scope. No file lists; no step tables (those belong in the detailed plan).
- `diagrams[]` — one or more `{ "title": string, "mermaid": string }`:
  - Prefer a `flowchart` of the change (before → after, or components touched).
  - A `sequenceDiagram` is fine for request/response or agent/human gates.
  - Mermaid must be valid: first line is a diagram type (`flowchart`, `sequenceDiagram`, …);
    no spaces in node IDs; quote labels that contain special characters.
  - At least one diagram is required whenever there is at least one plan step.

## Good diagram sketch

```
flowchart LR
  spec[ApprovedSpec] --> plan[DetailedPlan]
  plan --> code[CodingAgent]
  code --> review[HumanReview]
```

Do not invent business decisions. Do not approve anything.

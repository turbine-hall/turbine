# core/decompose-task

Split an approved plan into small, reviewable subtasks before implementation.

Produce structured JSON matching schema `task-decomposition`:

```json
{
  "summary": "1–2 sentences",
  "subtasks": [
    {
      "id": "ST1",
      "title": "short PR title",
      "description": "what this subtask changes and why (enough for a reviewer)",
      "requirementIds": ["FR-001"],
      "files": ["src/…"],
      "branchName": "optional-branch-suffix"
    }
  ]
}
```

## Rules

- Prefer 2–6 subtasks for normal work; a single subtask is allowed when the change is already small.
- Every requirement ID from the approved plan/spec must appear in at least one subtask.
- Each subtask must be small enough for one focused PR (one concern, limited files).
- `title` becomes the PR title; `description` becomes the PR body (engine adds work id + requirement list).
- `branchName` is optional; when omitted the engine uses `st-<id>` (lowercased).
- Do not invent business decisions. Do not approve requirements, plans, merges, or deployments.
- Do not claim tool grants.

# Task workflow (with `task-decomposer`)

Full Turbine Hall task lifecycle, including the **task-decomposer** step that runs automatically before execution and opens one small PR per subtask.

## End-to-end flowchart

```mermaid
flowchart TD
  start([Create task]) --> assess[Assess / sync]
  assess --> needsQ{Open questions?}
  needsQ -->|yes| clarify[NEEDS_CLARIFICATION]
  clarify --> editSpec[Edit SPEC.md answers]
  editSpec --> assess
  needsQ -->|no| reqReview[REQUIREMENTS_REVIEW]
  reqReview --> reqGate{Requirements gate}
  reqGate -->|human or lane policy approve| reqOk[REQUIREMENTS_APPROVED]
  reqGate -->|reject / changes| clarify
  reqOk --> plan[Plan]
  plan --> planReview[PLAN_REVIEW]
  planReview --> planGate{Plan gate}
  planGate -->|human or lane policy approve| planOk[PLAN_APPROVED]
  planGate -->|reject / changes| plan
  planOk --> execute[task execute / sync into execute]
  execute --> decomposer[task-decomposer role]
  decomposer --> skill[core/decompose-task]
  skill --> subtasks[Small subtasks ST1…STn]
  subtasks --> prCheck{pr.create allowed?}
  prCheck -->|no| failClosed([Fail closed — stay PLAN_APPROVED])
  prCheck -->|yes| openPrs[Open one GitHub PR per subtask]
  openPrs --> record[Save task-decomposition artifact + DECOMPOSITION.md]
  record --> implementing[IMPLEMENTING]
  implementing --> codeWork[Code in worktree]
  codeWork --> aiReview[AI_REVIEW]
  aiReview --> humanReview[HUMAN_CODE_REVIEW]
  humanReview --> codeGate{Code review gate}
  codeGate -->|approve| verifying[VERIFYING]
  codeGate -->|changes requested| changesReq[CHANGES_REQUESTED]
  changesReq --> execute
  verifying --> acceptance[HUMAN_ACCEPTANCE]
  acceptance --> acceptGate{Acceptance gate}
  acceptGate -->|approve| accepted[ACCEPTED]
  acceptGate -->|reject| changesReq
  accepted --> landPr[Landing PR turbine/work_id]
  landPr --> done([Merged / complete])
```

## Sequence: pre-execute decomposition

```mermaid
sequenceDiagram
  participant Human
  participant CLI as Turbine CLI
  participant Engine
  participant Decomposer as task-decomposer
  participant Skill as core/decompose-task
  participant Model
  participant GitHub
  participant Packet as Task packet

  Human->>CLI: approve plan
  CLI->>Engine: PLAN_APPROVED
  Human->>CLI: task execute / sync
  CLI->>Engine: execute work_id
  Engine->>Engine: check plan/spec approvals
  Engine->>Decomposer: run before IMPLEMENTING
  Decomposer->>Engine: require pr.create
  Decomposer->>Skill: runAsRole
  Skill->>Model: schema task-decomposition
  Model-->>Skill: subtasks ST1…STn
  loop Each subtask
    Decomposer->>Engine: branch turbine/work_id-st-…
    Decomposer->>GitHub: pr.create title + body
    GitHub-->>Decomposer: PR number + url
  end
  Decomposer->>Packet: DECOMPOSITION.md
  Decomposer->>Engine: artifact task-decomposition + event
  Engine->>Engine: transition IMPLEMENTING
  Engine-->>CLI: worktree / implementer handoff
```

## State machine (work item)

```mermaid
stateDiagram-v2
  [*] --> IMPORTED: task create
  IMPORTED --> ASSESSING: assess
  ASSESSING --> NEEDS_CLARIFICATION: open questions
  ASSESSING --> REQUIREMENTS_REVIEW: ready
  NEEDS_CLARIFICATION --> REQUIREMENTS_REVIEW: answers + sync
  REQUIREMENTS_REVIEW --> REQUIREMENTS_APPROVED: approve
  REQUIREMENTS_APPROVED --> PLANNING: plan
  PLANNING --> PLAN_REVIEW: plan ready
  PLAN_REVIEW --> PLAN_APPROVED: approve
  PLAN_APPROVED --> IMPLEMENTING: execute\n(+ task-decomposer first)
  IMPLEMENTING --> AI_REVIEW: commits captured
  AI_REVIEW --> HUMAN_CODE_REVIEW: review done
  HUMAN_CODE_REVIEW --> VERIFYING: approve
  HUMAN_CODE_REVIEW --> CHANGES_REQUESTED: request changes
  VERIFYING --> HUMAN_ACCEPTANCE: checks pass
  HUMAN_ACCEPTANCE --> ACCEPTED: accept
  HUMAN_ACCEPTANCE --> CHANGES_REQUESTED: reject
  CHANGES_REQUESTED --> IMPLEMENTING: execute again\n(reuse decomposition if same plan)
  ACCEPTED --> [*]
```

## What `task-decomposer` produces

| Output | Where |
|---|---|
| Subtask list (id, title, description, requirementIds, files) | Model → `task-decomposition` artifact |
| **Subtask count** (visible) | `DECOMPOSITION.md` header (`**Subtasks: N**`) + `task.decomposition-ready` event + `turbine task next` |
| One branch per subtask | `turbine/<workId>-st-…` at **`git.defaultBaseBranch` tip** (not the current checkout) |
| One PR per subtask | GitHub via `pr.create` against `git.defaultBaseBranch`; refuses mega-diffs over `git.maxSubtaskPrChangedLines` |
| Human-readable table | `.turbine/tasks/<workId>/DECOMPOSITION.md` |
| Audit events | `task.decomposition-ready`, then `task.decomposed` |

Configure in `.turbine/project.yaml`:

```yaml
git:
  defaultBaseBranch: main
  maxSubtaskPrChangedLines: 400
```

Same plan hash on a later execute → **reuse** recorded PRs (no duplicates).

Local human gates (requirements/plan/code review/acceptance) stay on by default; relax them only with an approved lane policy (`turbine policy approve …`) so humans review GitHub PRs instead.

## Parent vs landing PR

```mermaid
flowchart LR
  subgraph beforeExec [Before IMPLEMENTING]
    ST1[Subtask PR ST1]
    ST2[Subtask PR ST2]
    STn[Subtask PR STn]
  end
  subgraph afterAccept [After ACCEPTED]
    Land["Landing PR turbine/work_id"]
  end
  Parent[Parent Turbine work item] --> beforeExec
  Parent --> afterAccept
```

- **Subtask PRs** — opened by `task-decomposer` so each slice is reviewable early.
- **Landing PR** — still the accepted head for the parent task (`turbine/<workId>`), unchanged by decomposition.

/** Written to .turbine/GLOSSARY.md on init; linked from every STATUS.md. */
export const GLOSSARY = `# Turbine Hall — glossary

Short definitions for the words used in task documents.

| Term | Meaning |
|---|---|
| **Task / work item** | One requested change, with an ID like \`work_01…\`. Its documents live in \`.turbine/tasks/<id>/\`. |
| **STATUS.md** | Where the task is, who acts next, and what blocks it. Start here. |
| **SPEC.md** | What must be true when the task is done (requirements), open questions, and context. Links to the plan docs. |
| **PLAN.md** | Detailed implementation plan: architecture, data model, interfaces, steps, tests, risks, coding-agent token estimate. |
| **EXECUTIVE-SUMMARY.md** | Short high-level plan narrative plus Mermaid diagrams of the change. |
| **REVIEW.md** | What actually changed (from git), traceability, AI review, check results, and the acceptance checklist. |
| **evidence/** | Raw data (JSON, logs) behind the documents. You rarely need it. |
| **Coding-agent token estimate** | Heuristic budget for the coding agent (\`confidence: estimated\`). Not billed cost and not this planning call's usage. |
| **Requirement (FR-001)** | One checkable rule, ideally "WHEN … THE SYSTEM SHALL …". |
| **P0 / P1 / P2** | Priority. P0 must work for the task to be accepted; P1 should; P2 is nice to have. |
| **Open question** | A decision only a human can make. Questions block approval until answered. |
| **✅ Verified / 🟡 Assumption** | Verified = read from the request, git or a project file. Assumption = a reasonable default someone must confirm. |
| **Gate** | A point where a human must approve before work continues: requirements, plan, code review, acceptance. |
| **Approve** | Only by a human, with \`turbine task approve <id>\` in their own terminal. Editing markdown never approves. |
| **Worktree** | A separate folder (on branch \`turbine/<id>\`) where the code for this task is written, so your main checkout is untouched. |
| **Base / head commit** | Base = where the task branch started. Head = the latest commit on it. |
| **Change set** | The exact code under review: the head commit (or, for multi-repo tasks, all repos' heads together). Approvals are tied to it; a new commit makes them stale. |
| **Stale** | An approval or check that was for an older version, so it no longer counts. |
| **Checks** | Commands from \`quality.checks\` (lint, tests, build…) that turbine actually runs in the worktree. |
| **AI review** | An AI reads the real diff. Findings it cannot tie to changed code are discarded. It is advice, never approval. |
| **Traceability** | Which plan steps, files and tests cover each requirement. FULL = a changed test is linked and checks pass; PARTIAL = not proven; NONE = not planned. |
| **Gate decision PASS / CONCERNS / FAIL** | Computed from evidence. FAIL = something required is missing; CONCERNS = only optional things are missing (e.g. a P0 without a linked test). |
| **Waiver** | A named human accepting the risk of a missing item, with a reason and an expiry. The gate still says FAIL. |
| **ACCEPTED** | The task's evidence is complete and a human accepted it. It is **not** merged or deployed — open a PR for that. |
`;

export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  current_state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_aliases (
  alias TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES work_items(id)
);

CREATE TABLE IF NOT EXISTS source_snapshots (
  hash TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  type TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  data TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  data TEXT NOT NULL,
  invalidated_at TEXT
);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS role_runs (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  work_id TEXT,
  type TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  correlation_id TEXT
);

CREATE TABLE IF NOT EXISTS eec_contracts (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  UNIQUE(work_id, revision)
);

CREATE TABLE IF NOT EXISTS artifact_dependency_edges (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS eec_invalidation_events (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recovery_plans (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  data TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_counters (
  work_id TEXT PRIMARY KEY,
  model_calls INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_work_state ON work_items(current_state);
CREATE INDEX IF NOT EXISTS idx_artifacts_work ON artifacts(work_id, type);
CREATE INDEX IF NOT EXISTS idx_events_work ON events(work_id, sequence);
`,
  },
  {
    version: 2,
    sql: `
CREATE TABLE IF NOT EXISTS repo_snapshots (
  hash TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  "commit" TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- two clones at the same commit share a hash, so a snapshot is keyed by (repository, hash)
  PRIMARY KEY (repo_path, hash)
);

CREATE INDEX IF NOT EXISTS idx_repo_snapshots_repo ON repo_snapshots(repo_path);
CREATE INDEX IF NOT EXISTS idx_repo_snapshots_hash ON repo_snapshots(hash);
`,
  },
  {
    version: 3,
    sql: `
-- One row per work item that a long-running stage (planning) currently owns.
CREATE TABLE IF NOT EXISTS work_claims (
  work_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  purpose TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);
`,
  },
  {
    version: 4,
    sql: `
-- Layer 2 claims. "data" is the claim (statement, evidence, verifier); the status says whether it may be published.
CREATE TABLE IF NOT EXISTS claims (
  id TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  section TEXT NOT NULL,
  "commit" TEXT NOT NULL,
  data TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified', 'rejected', 'withdrawn', 'attested')),
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_path, id)
);

CREATE INDEX IF NOT EXISTS idx_claims_repo_section ON claims(repo_path, section);
CREATE INDEX IF NOT EXISTS idx_claims_repo_commit ON claims(repo_path, "commit");
`,
  },
  {
    version: 5,
    sql: `
-- Layer 2: the commit the claims of a repository have been carried to. It only moves forward, and it survives the
-- withdrawal of the last claim, so a later publication cannot reopen a commit the transitions have already passed.
CREATE TABLE IF NOT EXISTS claim_frontier (
  repo_path TEXT PRIMARY KEY,
  "commit" TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 6,
    sql: `
-- Layer 2 brief approval state. claims_hash is the published claim set; approved_hash is set only after a human gate.
CREATE TABLE IF NOT EXISTS brief_state (
  repo_path TEXT PRIMARY KEY,
  "commit" TEXT NOT NULL,
  claims_hash TEXT NOT NULL,
  approved_hash TEXT,
  approved_by TEXT,
  approved_at TEXT,
  sample_cap INTEGER NOT NULL,
  sample_paths TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 7,
    sql: `
-- Sections awaiting understand redraft after a deterministic handoff withdrawal (task next / execute).
ALTER TABLE brief_state ADD COLUMN pending_sections TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    version: 8,
    sql: `
-- Per-task usage records (coding-agent reported / imported). Turbine model calls stay in role_runs.
CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  data TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_records_work ON usage_records(work_id);
`,
  },
  {
    version: 9,
    sql: `
-- Approved lane policy snapshots. The file in .turbine/policies/ may change; only this approved copy can pass a gate.
-- "pending" (file drift) is derived by comparing the file's hash with content_hash; it is never stored.
CREATE TABLE IF NOT EXISTS lane_policies (
  name TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  data TEXT NOT NULL,
  approved_decision_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  suspended_reason TEXT,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 10,
    sql: `
-- Per-lens agreement from completed autonomous dual reviews, retained for later metrics.
CREATE TABLE IF NOT EXISTS reviewer_agreements (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  change_set_id TEXT NOT NULL,
  lens TEXT NOT NULL,
  data TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviewer_agreements_work ON reviewer_agreements(work_id, change_set_id);
`,
  },
  {
    version: 11,
    sql: `
-- Merge facts are deliberately optional until Part C. Absence means unknown, never "not merged".
CREATE TABLE IF NOT EXISTS lane_merge_records (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  policy_id TEXT,
  opened_at TEXT NOT NULL,
  merged_at TEXT,
  data TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lane_merge_policy ON lane_merge_records(policy_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_lane_merge_work ON lane_merge_records(work_id);

-- Only selected draws enter this queue. The seed, draw and rate make every selection reproducible.
CREATE TABLE IF NOT EXISTS lane_audit_queue (
  id TEXT PRIMARY KEY,
  merge_record_id TEXT NOT NULL UNIQUE REFERENCES lane_merge_records(id),
  work_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('queued', 'ok', 'problem')),
  data TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  recorded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_lane_audit_next ON lane_audit_queue(outcome, queued_at);
CREATE INDEX IF NOT EXISTS idx_lane_audit_policy ON lane_audit_queue(policy_id, queued_at);
`,
  },
];

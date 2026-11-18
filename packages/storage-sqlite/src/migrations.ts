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
  hash TEXT PRIMARY KEY,
  repo_path TEXT NOT NULL,
  "commit" TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_repo_snapshots_repo ON repo_snapshots(repo_path);
`,
  },
];

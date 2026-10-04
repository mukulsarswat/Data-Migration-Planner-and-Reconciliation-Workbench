-- Control-plane schema (idempotent). The mock target table `tgt_accounts` is generated from target-schema.json
-- (server/src/db/targetDdl.ts) so its CHECK constraints can never drift from the JS validator.

-- Mock source system: one row per legacy record. `source_key` is a surrogate (r0001…); the legacy key lives in payload.
CREATE TABLE IF NOT EXISTS src_legacy_customers (
  row_no      INTEGER PRIMARY KEY,
  source_key  TEXT NOT NULL UNIQUE,
  payload     TEXT NOT NULL,            -- JSON object of raw string values
  row_hash    TEXT NOT NULL
);

-- Workspaces ("migrations"): exactly one is current. A new workspace never deletes history.
CREATE TABLE IF NOT EXISTS migrations (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  is_current  INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0, 1)),
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_migrations_current ON migrations (is_current) WHERE is_current = 1;

CREATE TABLE IF NOT EXISTS agent_runs (
  id                 INTEGER PRIMARY KEY,
  migration_id       INTEGER NOT NULL REFERENCES migrations (id),
  status             TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')),
  mode               TEXT NOT NULL CHECK (mode IN ('live', 'scripted')),
  model              TEXT NOT NULL,
  response_model     TEXT,
  based_on_version   INTEGER,
  iterations         INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms         INTEGER,
  error_code         TEXT,
  error              TEXT,
  result_version     INTEGER,
  client_ip          TEXT,
  created_at         TEXT NOT NULL,
  finished_at        TEXT
);
CREATE INDEX IF NOT EXISTS ix_agent_runs_created ON agent_runs (created_at);

CREATE TABLE IF NOT EXISTS agent_steps (
  id                INTEGER PRIMARY KEY,
  agent_run_id      INTEGER NOT NULL REFERENCES agent_runs (id),
  seq               INTEGER NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('llm', 'tool', 'system')),
  tool_name         TEXT,
  input_json        TEXT,
  output_summary    TEXT,
  thinking_summary  TEXT,
  is_error          INTEGER NOT NULL DEFAULT 0,
  stop_reason       TEXT,
  request_id        TEXT,
  model             TEXT,
  duration_ms       INTEGER,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  cache_read_tokens INTEGER,
  created_at        TEXT NOT NULL,
  UNIQUE (agent_run_id, seq)
);

-- Immutable plan versions.
CREATE TABLE IF NOT EXISTS plan_versions (
  id              INTEGER PRIMARY KEY,
  migration_id    INTEGER NOT NULL REFERENCES migrations (id),
  version         INTEGER NOT NULL,
  parent_version  INTEGER,
  author          TEXT NOT NULL CHECK (author IN ('agent', 'heuristic', 'user')),
  actor           TEXT NOT NULL,
  plan_json       TEXT NOT NULL,
  plan_hash       TEXT NOT NULL,
  agent_run_id    INTEGER REFERENCES agent_runs (id),
  change_note     TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  UNIQUE (migration_id, version)
);

-- One terminal decision per plan version (approve or reject). Changing your mind = new version.
CREATE TABLE IF NOT EXISTS approvals (
  id               INTEGER PRIMARY KEY,
  plan_version_id  INTEGER NOT NULL UNIQUE REFERENCES plan_versions (id),
  plan_hash        TEXT NOT NULL,
  decision         TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reviewer         TEXT NOT NULL,
  comment          TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id               INTEGER PRIMARY KEY,
  migration_id     INTEGER NOT NULL REFERENCES migrations (id),
  plan_version_id  INTEGER REFERENCES plan_versions (id),
  plan_hash        TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('dry_run', 'execute', 'rollback')),
  attempt          INTEGER NOT NULL DEFAULT 1,
  parent_run_id    INTEGER UNIQUE REFERENCES runs (id),   -- each run can be retried once (retry the child after that)
  status           TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'interrupted')),
  counts           TEXT NOT NULL DEFAULT '{}',
  result_hash      TEXT,
  options          TEXT NOT NULL DEFAULT '{}',
  actor            TEXT NOT NULL DEFAULT 'system',
  error_code       TEXT,
  error            TEXT,
  started_at       TEXT NOT NULL,
  finished_at      TEXT
);
-- Run lock: at most one mutating run in flight per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS ux_runs_one_running ON runs (migration_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS ix_runs_migration ON runs (migration_id, id);

-- Per-record outcomes + field-level evidence (quarantine).
CREATE TABLE IF NOT EXISTS run_records (
  run_id       INTEGER NOT NULL REFERENCES runs (id),
  source_key   TEXT NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('accepted', 'transform_failed', 'validation_rejected',
                                                'inserted', 'skipped_existing', 'conflict', 'load_rejected')),
  errors       TEXT NOT NULL DEFAULT '[]',
  transformed  TEXT,
  PRIMARY KEY (run_id, source_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_run_records_outcome ON run_records (run_id, outcome);

-- Load ledger: which target rows this workspace inserted. Drives idempotent retry and rollback.
CREATE TABLE IF NOT EXISTS load_ledger (
  id               INTEGER PRIMARY KEY,
  migration_id     INTEGER NOT NULL REFERENCES migrations (id),
  plan_version_id  INTEGER NOT NULL REFERENCES plan_versions (id),
  source_key       TEXT NOT NULL,
  target_id        INTEGER NOT NULL,
  external_ref     TEXT NOT NULL,
  run_id           INTEGER NOT NULL REFERENCES runs (id),
  row_hash         TEXT NOT NULL,
  inserted_at      TEXT NOT NULL,
  rolled_back_at   TEXT,
  rollback_run_id  INTEGER REFERENCES runs (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_active ON load_ledger (migration_id, source_key) WHERE rolled_back_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_ledger_run ON load_ledger (run_id);

-- Append-only audit history.
CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY,
  migration_id     INTEGER REFERENCES migrations (id),
  type             TEXT NOT NULL,
  actor            TEXT NOT NULL,
  plan_version_id  INTEGER,
  run_id           INTEGER,
  agent_run_id     INTEGER,
  payload          TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_migration ON events (migration_id, id);

-- Immutability guards (append-only history; immutable plans and decisions).
CREATE TRIGGER IF NOT EXISTS trg_events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_plan_versions_no_update BEFORE UPDATE ON plan_versions
BEGIN SELECT RAISE(ABORT, 'plan versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_plan_versions_no_delete BEFORE DELETE ON plan_versions
BEGIN SELECT RAISE(ABORT, 'plan versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_approvals_no_update BEFORE UPDATE ON approvals
BEGIN SELECT RAISE(ABORT, 'approval decisions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS trg_approvals_no_delete BEFORE DELETE ON approvals
BEGIN SELECT RAISE(ABORT, 'approval decisions are immutable'); END;

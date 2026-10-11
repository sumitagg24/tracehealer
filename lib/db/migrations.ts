import type { SqlDriver } from "@/lib/db/driver";

/**
 * Versioned migrations.
 *
 * Each migration is applied once inside a transaction and recorded in
 * `schema_migrations`, so re-running them is a no-op and a partially applied
 * migration can never be observed. Never edit a shipped migration; append a new
 * one.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "core-run-lifecycle",
    sql: `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT,
  state TEXT NOT NULL,
  status TEXT,
  mode TEXT NOT NULL,
  trace_id TEXT,
  idempotency_key TEXT,
  summary_json TEXT NOT NULL,
  result_json TEXT,
  delivery_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS runs_tenant_idempotency
  ON runs (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_tenant_created ON runs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS runs_state ON runs (state);

CREATE TABLE IF NOT EXISTS run_transitions (
  seq INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_transitions_run ON run_transitions (run_id, seq);

CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  state TEXT NOT NULL,
  message TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  actor TEXT NOT NULL DEFAULT 'orchestrator',
  correlation_id TEXT,
  detail_json TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_run ON audit_events (run_id, seq);
CREATE INDEX IF NOT EXISTS audit_events_tenant ON audit_events (tenant_id, at DESC);

CREATE TABLE IF NOT EXISTS webhook_replays (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_replays_received ON webhook_replays (received_at DESC);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  seq INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS delivery_attempts_run ON delivery_attempts (run_id, seq);

CREATE TABLE IF NOT EXISTS tenant_policies (
  tenant_id TEXT PRIMARY KEY,
  policy_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: "durable-job-queue",
    sql: `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  priority INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  available_at TEXT NOT NULL,
  last_error TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_claimable
  ON jobs (status, available_at, priority DESC, created_at);
CREATE INDEX IF NOT EXISTS jobs_run ON jobs (run_id);
CREATE INDEX IF NOT EXISTS jobs_lease ON jobs (status, lease_expires_at);
`,
  },
  {
    version: 3,
    name: "artifact-metadata",
    sql: `
CREATE TABLE IF NOT EXISTS artifacts (
  run_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, kind)
);
CREATE INDEX IF NOT EXISTS artifacts_tenant_created ON artifacts (tenant_id, created_at DESC);
`,
  },
  {
    version: 4,
    name: "shared-rate-limit",
    sql: `
CREATE TABLE IF NOT EXISTS rate_limit_windows (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limit_windows_start ON rate_limit_windows (window_start);
`,
  },
];

export interface MigrationResult {
  /** Versions applied by this call. */
  applied: number[];
  /** Versions that were already present. */
  existing: number[];
  /** Highest version present after migrating. */
  version: number;
}

/** Apply every pending migration. Safe to call on every process start. */
export async function migrate(driver: SqlDriver): Promise<MigrationResult> {
  await driver.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`);

  const rows = await driver.query<{ version: number }>("SELECT version FROM schema_migrations");
  const present = new Set(rows.map((row) => Number(row.version)));

  const pending = MIGRATIONS.filter((migration) => !present.has(migration.version)).sort(
    (a, b) => a.version - b.version,
  );

  const applied: number[] = [];
  for (const migration of pending) {
    // `driver.exec` must run on the same connection as the active transaction;
    // every supported driver holds one connection for the duration of `transaction`.
    await driver.transaction(async (tx) => {
      await driver.exec(migration.sql);
      await tx.execute(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        [migration.version, migration.name, new Date().toISOString()],
      );
    });
    applied.push(migration.version);
  }

  return {
    applied,
    existing: [...present].sort((a, b) => a - b),
    version: Math.max(0, ...present, ...applied),
  };
}

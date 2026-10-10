/**
 * Minimal, dialect-neutral SQL surface used by the durable adapters.
 *
 * Everything above this file (state store, job queue, artifact metadata) is
 * written against `SqlDriver` only, so a networked database can be substituted
 * by implementing this one interface. The default implementation is SQLite
 * (`lib/db/sqlite.ts`), which is transactional, durable, and requires no
 * external service.
 */

export type SqlParam = string | number | bigint | null | Uint8Array;

/** A statement executor. Inside a transaction this is bound to the same handle. */
export interface SqlExecutor {
  /** All matching rows as plain objects. */
  query<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  /** The first matching row, or null. */
  queryOne<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | null>;
  /** Run a statement and return the number of affected rows. */
  execute(sql: string, params?: SqlParam[]): Promise<number>;
}

export interface SqlDriver extends SqlExecutor {
  /** Human-readable driver name for readiness and evidence. */
  readonly driver: string;
  readonly dialect: "sqlite" | "postgres";
  /** Raw multi-statement execution, used only by migrations. */
  exec(sql: string): Promise<void>;
  /**
   * Serialized write transaction. The callback must not start a nested
   * transaction; nested calls join the outer one.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /** Cheap liveness probe used by the readiness endpoint. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export function assertDriver(driver: SqlDriver | null | undefined): SqlDriver {
  if (!driver) throw new Error("A SQL driver is required");
  return driver;
}

/**
 * True when a driver error means another writer holds the database lock. Callers
 * treat this as contention (retry later) rather than as a failure.
 */
export function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked|SQLITE_LOCKED|deadlock detected/i.test(message);
}

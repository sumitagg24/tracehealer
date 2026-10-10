import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { SqlDriver, SqlExecutor, SqlParam } from "@/lib/db/driver";
import { TraceHealerError } from "@/lib/errors";


/**
 * SQLite implementation of `SqlDriver` built on Node's `node:sqlite`, so the
 * durable adapter needs no third-party dependency and no external service.
 *
 * WAL journalling plus a busy timeout let several processes share one database
 * file safely, which is what `BEGIN IMMEDIATE` below relies on: a writer takes
 * the reserved lock up front so two workers cannot claim the same job.
 */

interface SqliteStatementLike {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes?: number | bigint; lastInsertRowid?: number | bigint };
}

interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

function normaliseParams(params: SqlParam[] = []): unknown[] {
  return params.map((value) => (typeof value === "boolean" ? (value ? 1 : 0) : value));
}

class SqliteExecutor implements SqlExecutor {
  constructor(private readonly db: SqliteDatabaseLike) {}

  async query<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...normaliseParams(params)) as T[];
  }

  async queryOne<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | null> {
    const row = this.db.prepare(sql).get(...normaliseParams(params));
    return (row ?? null) as T | null;
  }

  async execute(sql: string, params: SqlParam[] = []): Promise<number> {
    const result = this.db.prepare(sql).run(...normaliseParams(params));
    return Number(result.changes ?? 0);
  }
}

class SqliteDriver implements SqlDriver {
  readonly driver = "sqlite";
  readonly dialect = "sqlite" as const;
  private depth = 0;
  private readonly executor: SqlExecutor;

  constructor(private readonly db: SqliteDatabaseLike) {
    this.executor = new SqliteExecutor(db);
  }

  query<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T[]> {
    return this.executor.query<T>(sql, params);
  }

  queryOne<T = Record<string, unknown>>(sql: string, params: SqlParam[] = []): Promise<T | null> {
    return this.executor.queryOne<T>(sql, params);
  }

  execute(sql: string, params: SqlParam[] = []): Promise<number> {
    return this.executor.execute(sql, params);
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    // Nested calls join the outer transaction so a handler can reuse a shared
    // helper without silently committing part of its work.
    if (this.depth > 0) {
      this.depth += 1;
      try {
        return await fn(this);
      } finally {
        this.depth -= 1;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const result = await fn(this);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // A failed rollback must not mask the original error.
      }
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  async ping(): Promise<void> {
    this.db.prepare("SELECT 1 AS ok").get();
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/**
 * Open (creating if needed) a SQLite database with production-safe pragmas.
 * `node:sqlite` is loaded lazily so the zero-config filesystem mode keeps
 * working on Node versions where the module is unavailable.
 */
export async function openSqliteDriver(
  file: string,
  options: { busyTimeoutMs?: number } = {},
): Promise<SqlDriver> {
  let sqlite: { DatabaseSync: new (path: string) => SqliteDatabaseLike };
  try {
    sqlite = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string) => SqliteDatabaseLike;
    };
  } catch (error) {
    throw new TraceHealerError(
      "unconfigured",
      "The sqlite persistence driver requires a Node runtime with the built-in node:sqlite module",
      { cause: error },
    );
  }

  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const db = new sqlite.DatabaseSync(path.resolve(file));
  db.exec(
    [
      "PRAGMA journal_mode = WAL",
      `PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs ?? 10_000))}`,
      "PRAGMA foreign_keys = ON",
      "PRAGMA synchronous = NORMAL",
    ].join("; "),
  );
  return new SqliteDriver(db);
}

import { randomUUID } from "node:crypto";
import type { SqlDriver, SqlExecutor, SqlParam } from "@/lib/db/driver";
import { migrate, type MigrationResult } from "@/lib/db/migrations";
import { TraceHealerError } from "@/lib/errors";
import { assertTransition, canTransition } from "@/lib/run-state";
import type { AuditEvent, HealResult, RunState, RunSummary } from "@/lib/types";

/**
 * Durable, transactional state for runs, transitions, audit events, idempotency
 * keys, webhook replay IDs, cancellation, and delivery attempts.
 *
 * Every read and write is scoped by `tenantId`: a request for another tenant's
 * run resolves to `null`, which the API turns into `404` so identifiers cannot
 * be enumerated across tenants.
 */

export interface DurableRunRecord {
  id: string;
  tenantId: string;
  workspaceId: string | null;
  state: RunState;
  status: string;
  mode: string;
  traceId: string;
  idempotencyKey: string | null;
  summary: RunSummary;
  result: HealResult | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CreateRunInput {
  tenantId: string;
  workspaceId?: string;
  mode: "demo" | "connected";
  traceId: string;
  idempotencyKey?: string;
  runId?: string;
  state?: RunState;
  at?: string;
}

export interface CreateRunOutcome {
  record: DurableRunRecord;
  deduplicated: boolean;
}

export interface ListOptions {
  limit?: number;
  /** Keyset cursor: `createdAt|id` of the previous page's last row. */
  cursor?: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface TransitionInput {
  tenantId: string;
  runId: string;
  to: RunState;
  reason?: string;
  actor?: string;
  correlationId?: string;
  detail?: Record<string, unknown>;
  at?: string;
}

interface RunRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  state: string;
  status: string | null;
  mode: string;
  trace_id: string | null;
  idempotency_key: string | null;
  summary_json: string;
  result_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface EventRow {
  seq: number;
  at: string;
  state: string;
  message: string;
  attempt: number;
  actor: string;
  correlation_id: string | null;
  detail_json: string | null;
}

function parse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function clampLimit(limit: number | undefined, fallback = 25): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.trunc(limit as number), 1), 100);
}

function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed|duplicate key value/i.test(message);
}

export class DurableStateStore {
  private readonly at: () => Date;

  private constructor(
    private readonly driver: SqlDriver,
    private readonly migrations: MigrationResult,
    options: { now?: () => Date } = {},
  ) {
    this.at = options.now ?? (() => new Date());
  }

  /** Open the database and bring the schema up to date. */
  static async open(
    driver: SqlDriver,
    options: { now?: () => Date } = {},
  ): Promise<DurableStateStore> {
    const migrations = await migrate(driver);
    return new DurableStateStore(driver, migrations, options);
  }

  get schemaVersion(): number {
    return this.migrations.version;
  }

  get persistence(): { driver: string; dialect: string; schemaVersion: number } {
    return {
      driver: this.driver.driver,
      dialect: this.driver.dialect,
      schemaVersion: this.migrations.version,
    };
  }

  async health(): Promise<{ ok: boolean; driver: string; schemaVersion: number }> {
    await this.driver.ping();
    const rows = await this.driver.query<{ version: number }>(
      "SELECT MAX(version) AS version FROM schema_migrations",
    );
    return {
      ok: true,
      driver: this.driver.driver,
      schemaVersion: Number(rows[0]?.version ?? this.migrations.version),
    };
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  // ---------------------------------------------------------------- runs

  /**
   * Create a run, or return the existing run for the same tenant/idempotency
   * key. The insert is guarded by a unique index, so two concurrent workers
   * cannot both create a run for one key.
   */
  async createRun(input: CreateRunInput): Promise<CreateRunOutcome> {
    const existing = input.idempotencyKey
      ? await this.findByIdempotencyKey(input.tenantId, input.idempotencyKey)
      : null;
    if (existing) return { record: existing, deduplicated: true };

    const runId = input.runId ?? `heal_${randomUUID().slice(0, 8)}`;
    const at = (input.at ?? this.at().toISOString());
    const state = input.state ?? "queued";
    const summary: RunSummary = {
      id: runId,
      state,
      status: "needs-review",
      mode: input.mode,
      traceId: input.traceId,
      startedAt: at,
      completedAt: null,
      hasResult: false,
      idempotencyKey: input.idempotencyKey,
    };

    try {
      await this.driver.execute(
        `INSERT INTO runs (id, tenant_id, workspace_id, state, status, mode, trace_id,
                           idempotency_key, summary_json, result_json, delivery_json,
                           created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)`,
        [
          runId,
          input.tenantId,
          input.workspaceId ?? null,
          state,
          "needs-review",
          input.mode,
          input.traceId,
          input.idempotencyKey ?? null,
          JSON.stringify(summary),
          at,
          at,
        ],
      );
      await this.driver.execute(
        `INSERT INTO run_transitions (run_id, tenant_id, from_state, to_state, reason, at)
         VALUES (?, ?, NULL, ?, 'created', ?)`,
        [runId, input.tenantId, state, at],
      );
    } catch (error) {
      if (isUniqueViolation(error) && input.idempotencyKey) {
        const raced = await this.findByIdempotencyKey(input.tenantId, input.idempotencyKey);
        if (raced) return { record: raced, deduplicated: true };
      }
      throw error;
    }

    const record = await this.getRun(input.tenantId, runId);
    if (!record) throw new TraceHealerError("internal", "Run could not be read back after creation");
    return { record, deduplicated: false };
  }

  async getRun(tenantId: string, runId: string): Promise<DurableRunRecord | null> {
    const row = await this.driver.queryOne<RunRow>(
      "SELECT * FROM runs WHERE id = ? AND tenant_id = ?",
      [runId, tenantId],
    );
    return row ? this.toRecord(row) : null;
  }

  async findByIdempotencyKey(tenantId: string, key: string): Promise<DurableRunRecord | null> {
    const row = await this.driver.queryOne<RunRow>(
      "SELECT * FROM runs WHERE tenant_id = ? AND idempotency_key = ? ORDER BY created_at DESC LIMIT 1",
      [tenantId, key],
    );
    return row ? this.toRecord(row) : null;
  }

  async listRuns(tenantId: string, options: ListOptions = {}): Promise<Page<DurableRunRecord>> {
    const limit = clampLimit(options.limit);
    const params: SqlParam[] = [tenantId];
    let where = "WHERE tenant_id = ?";
    if (options.cursor) {
      const [createdAt, id] = String(options.cursor).split("|");
      if (createdAt && id) {
        where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
        params.push(createdAt, createdAt, id);
      }
    }
    params.push(limit + 1);
    const rows = await this.driver.query<RunRow>(
      `SELECT * FROM runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      params,
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((row) => this.toRecord(row));
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? `${last.createdAt}|${last.id}` : null,
    };
  }

  /**
   * Move a run to a new state. The current state is read inside the same
   * transaction, so the guard cannot be raced and an invalid transition throws
   * instead of silently overwriting.
   */
  async transition(input: TransitionInput): Promise<DurableRunRecord> {
    return this.driver.transaction(async (tx) => {
      const row = await tx.queryOne<RunRow>(
        "SELECT * FROM runs WHERE id = ? AND tenant_id = ?",
        [input.runId, input.tenantId],
      );
      if (!row) throw new TraceHealerError("not-found", "Run not found");
      const current = row.state as RunState;
      assertTransition(current, input.to);

      const at = input.at ?? this.at().toISOString();
      const summary = parse<RunSummary>(row.summary_json);
      const updatedSummary: RunSummary = {
        ...(summary ?? {
          id: row.id,
          state: current,
          status: "needs-review",
          mode: row.mode as "demo" | "connected",
          traceId: row.trace_id ?? row.id,
          startedAt: row.created_at,
          completedAt: null,
          hasResult: false,
        }),
        state: input.to,
        status: input.to === "healed" ? "healed" : "needs-review",
        completedAt: row.completed_at ?? null,
      };

      await tx.execute(
        `UPDATE runs SET state = ?, status = ?, summary_json = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
        [input.to, updatedSummary.status, JSON.stringify(updatedSummary), at, input.runId, input.tenantId],
      );
      await tx.execute(
        `INSERT INTO run_transitions (run_id, tenant_id, from_state, to_state, reason, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [input.runId, input.tenantId, current, input.to, input.reason ?? null, at],
      );
      if (input.reason) {
        await this.appendEventWith(tx, input.runId, input.tenantId, {
          seq: 0,
          at,
          state: input.to,
          message: input.reason,
          attempt: 1,
          actor: input.actor ?? "orchestrator",
          correlationId: input.correlationId ?? "system",
          detail: input.detail,
        });
      }

      const updated = await tx.queryOne<RunRow>(
        "SELECT * FROM runs WHERE id = ? AND tenant_id = ?",
        [input.runId, input.tenantId],
      );
      return this.toRecord(updated as RunRow);
    });
  }

  /** Record the finished result and settle the run in one transaction. */
  async saveResult(tenantId: string, result: HealResult): Promise<DurableRunRecord> {
    const at = result.completedAt ?? this.at().toISOString();
    const state = (result.state ?? "healed") as RunState;
    return this.driver.transaction(async (tx) => {
      const row = await tx.queryOne<RunRow>(
        "SELECT * FROM runs WHERE id = ? AND tenant_id = ?",
        [result.id, tenantId],
      );
      if (!row) throw new TraceHealerError("not-found", "Run not found");
      const summary = parse<RunSummary>(row.summary_json);
      const updatedSummary: RunSummary = {
        ...(summary ?? {
          id: result.id,
          state,
          status: result.status,
          mode: result.mode,
          traceId: result.traceId,
          startedAt: result.startedAt,
          completedAt: null,
          hasResult: true,
        }),
        state,
        status: result.status,
        hasResult: true,
        completedAt: at,
      };
      await tx.execute(
        `UPDATE runs SET state = ?, status = ?, summary_json = ?, result_json = ?,
                         delivery_json = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
        [
          state,
          result.status,
          JSON.stringify(updatedSummary),
          JSON.stringify(result),
          result.delivery ? JSON.stringify(result.delivery) : null,
          at,
          at,
          result.id,
          tenantId,
        ],
      );
      const updated = await tx.queryOne<RunRow>(
        "SELECT * FROM runs WHERE id = ? AND tenant_id = ?",
        [result.id, tenantId],
      );
      return this.toRecord(updated as RunRow);
    });
  }

  /** Settle a run that never produced a result (cancel, timeout, stale recovery). */
  async settle(
    tenantId: string,
    runId: string,
    state: RunState,
    reason: string,
  ): Promise<DurableRunRecord> {
    return this.driver.transaction(async (tx) => {
      const row = await tx.queryOne<RunRow>(
        "SELECT * FROM runs WHERE id = ? AND tenant_id = ?",
        [runId, tenantId],
      );
      if (!row) throw new TraceHealerError("not-found", "Run not found");
      const current = row.state as RunState;
      if (current === state) return this.toRecord(row);
      assertTransition(current, state);

      const at = this.at().toISOString();
      const summary = parse<RunSummary>(row.summary_json);
      const updatedSummary: RunSummary = {
        ...(summary as RunSummary),
        state,
        completedAt: at,
      };
      await tx.execute(
        `UPDATE runs SET state = ?, summary_json = ?, completed_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
        [state, JSON.stringify(updatedSummary), at, at, runId, tenantId],
      );
      await tx.execute(
        `INSERT INTO run_transitions (run_id, tenant_id, from_state, to_state, reason, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [runId, tenantId, current, state, reason, at],
      );
      await this.appendEventWith(tx, runId, tenantId, {
        seq: 0,
        at,
        state,
        message: reason,
        attempt: 1,
        actor: "orchestrator",
        correlationId: "system",
      });
      const updated = await tx.queryOne<RunRow>(
        "SELECT * FROM runs WHERE id = ? AND tenant_id = ?",
        [runId, tenantId],
      );
      return this.toRecord(updated as RunRow);
    });
  }

  async listTransitions(
    tenantId: string,
    runId: string,
  ): Promise<Array<{ from: string | null; to: string; reason: string | null; at: string }>> {
    const rows = await this.driver.query<{
      from_state: string | null;
      to_state: string;
      reason: string | null;
      at: string;
    }>(
      "SELECT from_state, to_state, reason, at FROM run_transitions WHERE run_id = ? AND tenant_id = ? ORDER BY seq ASC",
      [runId, tenantId],
    );
    return rows.map((row) => ({
      from: row.from_state,
      to: row.to_state,
      reason: row.reason,
      at: row.at,
    }));
  }

  /**
   * Upsert a run projection. A brand-new summary creates the run; an existing
   * one advances through the state machine when (and only when) the transition
   * is legal. A repeated or regressive state write is ignored rather than
   * overwriting a terminal decision.
   */
  async upsertSummary(
    tenantId: string,
    summary: RunSummary,
    meta: { workspaceId?: string } = {},
  ): Promise<RunSummary> {
    const existing = await this.getRun(tenantId, summary.id);
    if (!existing) {
      const created = await this.createRun({
        tenantId,
        workspaceId: meta.workspaceId,
        mode: summary.mode,
        traceId: summary.traceId,
        idempotencyKey: summary.idempotencyKey,
        runId: summary.id,
        state: summary.state,
        at: summary.startedAt,
      });
      return created.record.summary;
    }

    if (summary.state === existing.state) {
      return existing.summary;
    }
    if (!canTransition(existing.state, summary.state)) {
      // The run already settled; a late progress write must not resurrect it.
      return existing.summary;
    }
    const updated = await this.transition({
      tenantId,
      runId: summary.id,
      to: summary.state,
      reason: `state:${summary.state}`,
      at: new Date().toISOString(),
    });
    return updated.summary;
  }

  // -------------------------------------------------------------- events

  async appendEvent(tenantId: string, runId: string, event: AuditEvent): Promise<void> {
    await this.appendEventWith(this.driver, runId, tenantId, event);
  }

  private async appendEventWith(
    executor: SqlExecutor,
    runId: string,
    tenantId: string,
    event: AuditEvent,
  ): Promise<void> {
    await executor.execute(
      `INSERT INTO audit_events (run_id, tenant_id, state, message, attempt, actor,
                                 correlation_id, detail_json, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runId,
        tenantId,
        event.state,
        event.message,
        event.attempt ?? 1,
        event.actor ?? "orchestrator",
        event.correlationId ?? null,
        event.detail ? JSON.stringify(event.detail) : null,
        event.at,
      ],
    );
  }

  async listEvents(tenantId: string, runId: string): Promise<AuditEvent[]> {
    const rows = await this.driver.query<EventRow>(
      "SELECT * FROM audit_events WHERE run_id = ? AND tenant_id = ? ORDER BY seq ASC",
      [runId, tenantId],
    );
    return rows.map((row) => ({
      seq: Number(row.seq),
      at: row.at,
      state: row.state as RunState,
      message: row.message,
      attempt: Number(row.attempt),
      actor: row.actor,
      correlationId: row.correlation_id ?? "system",
      detail: parse<Record<string, unknown>>(row.detail_json) ?? undefined,
    }));
  }

  // ------------------------------------------------- replay / delivery

  /**
   * Record a webhook replay identifier. Returns `false` when the id was already
   * seen — including by another process sharing this database — which is the
   * durable replay guard.
   */
  async recordWebhookReplay(source: string, id: string): Promise<boolean> {
    const changes = await this.driver.execute(
      "INSERT OR IGNORE INTO webhook_replays (id, source, received_at) VALUES (?, ?, ?)",
      [id, source, this.at().toISOString()],
    );
    return changes > 0;
  }

  async countWebhookReplays(): Promise<number> {
    const rows = await this.driver.query<{ count: number }>(
      "SELECT COUNT(*) AS count FROM webhook_replays",
    );
    return Number(rows[0]?.count ?? 0);
  }

  async recordDeliveryAttempt(input: {
    tenantId: string;
    runId: string;
    channel: string;
    attempt: number;
    status: "succeeded" | "failed" | "skipped";
    error?: string | null;
    at?: string;
  }): Promise<void> {
    await this.driver.execute(
      `INSERT INTO delivery_attempts (run_id, tenant_id, channel, attempt, status, error, at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.runId,
        input.tenantId,
        input.channel,
        input.attempt,
        input.status,
        input.error ?? null,
        input.at ?? this.at().toISOString(),
      ],
    );
  }

  async listDeliveryAttempts(
    tenantId: string,
    runId: string,
  ): Promise<Array<{ channel: string; attempt: number; status: string; error: string | null; at: string }>> {
    const rows = await this.driver.query<{
      channel: string;
      attempt: number;
      status: string;
      error: string | null;
      at: string;
    }>(
      "SELECT channel, attempt, status, error, at FROM delivery_attempts WHERE run_id = ? AND tenant_id = ? ORDER BY seq ASC",
      [runId, tenantId],
    );
    return rows.map((row) => ({ ...row, attempt: Number(row.attempt) }));
  }

  // ---------------------------------------------------- tenant policies

  async setTenantPolicy(tenantId: string, policy: unknown): Promise<void> {
    await this.driver.execute(
      `INSERT INTO tenant_policies (tenant_id, policy_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(tenant_id) DO UPDATE SET policy_json = excluded.policy_json,
                                            updated_at = excluded.updated_at`,
      [tenantId, JSON.stringify(policy), this.at().toISOString()],
    );
  }

  async getTenantPolicy<T = unknown>(tenantId: string): Promise<T | null> {
    const row = await this.driver.queryOne<{ policy_json: string }>(
      "SELECT policy_json FROM tenant_policies WHERE tenant_id = ?",
      [tenantId],
    );
    return row ? parse<T>(row.policy_json) : null;
  }

  // ---------------------------------------------------------- retention

  /** Delete one run plus its derived rows. Used by tenant-scoped retention. */
  async deleteRun(tenantId: string, runId: string): Promise<boolean> {
    return this.driver.transaction(async (tx) => {
      const removed = await tx.execute("DELETE FROM runs WHERE id = ? AND tenant_id = ?", [
        runId,
        tenantId,
      ]);
      if (removed === 0) return false;
      await tx.execute("DELETE FROM run_transitions WHERE run_id = ? AND tenant_id = ?", [runId, tenantId]);
      await tx.execute("DELETE FROM audit_events WHERE run_id = ? AND tenant_id = ?", [runId, tenantId]);
      await tx.execute("DELETE FROM delivery_attempts WHERE run_id = ? AND tenant_id = ?", [runId, tenantId]);
      await tx.execute("DELETE FROM artifacts WHERE run_id = ? AND tenant_id = ?", [runId, tenantId]);
      await tx.execute("DELETE FROM jobs WHERE run_id = ? AND tenant_id = ?", [runId, tenantId]);
      return true;
    });
  }

  /** Retention sweep: delete settled runs older than `before`. */
  async pruneRuns(tenantId: string, before: string): Promise<number> {
    const rows = await this.driver.query<{ id: string }>(
      `SELECT id FROM runs WHERE tenant_id = ? AND created_at < ?
       AND state IN ('healed','needs-review','cancelled','timed-out')`,
      [tenantId, before],
    );
    let removed = 0;
    for (const row of rows) {
      if (await this.deleteRun(tenantId, row.id)) removed += 1;
    }
    return removed;
  }

  async pruneWebhookReplays(before: string): Promise<number> {
    return this.driver.execute("DELETE FROM webhook_replays WHERE received_at < ?", [before]);
  }

  private toRecord(row: RunRow): DurableRunRecord {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      state: row.state as RunState,
      status: row.status ?? "needs-review",
      mode: row.mode,
      traceId: row.trace_id ?? row.id,
      idempotencyKey: row.idempotency_key,
      summary: parse<RunSummary>(row.summary_json) ?? {
        id: row.id,
        state: row.state as RunState,
        status: "needs-review",
        mode: row.mode as "demo" | "connected",
        traceId: row.trace_id ?? row.id,
        startedAt: row.created_at,
        completedAt: row.completed_at,
        hasResult: Boolean(row.result_json),
      },
      result: parse<HealResult>(row.result_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }
}

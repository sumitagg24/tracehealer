import { randomUUID } from "node:crypto";
import { isBusyError, type SqlDriver, type SqlParam } from "@/lib/db/driver";

/**
 * Durable job queue on the transactional store.
 *
 * A worker *claims* a job by taking a time-bounded lease. The claim is a single
 * guarded UPDATE inside an immediate transaction, so two workers sharing the
 * database cannot claim the same job. A worker that dies mid-flight stops
 * heartbeating, its lease expires, and `recoverStale` returns the job to the
 * queue (or dead-letters it once the attempt budget is spent).
 */

export type JobStatus = "queued" | "leased" | "succeeded" | "dead-letter" | "cancelled";

export interface Job {
  id: string;
  runId: string;
  tenantId: string;
  kind: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  priority: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  availableAt: string;
  lastError: string | null;
  payload: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueInput {
  runId: string;
  tenantId: string;
  kind: string;
  payload?: unknown;
  priority?: number;
  maxAttempts?: number;
  delayMs?: number;
  jobId?: string;
}

export interface QueueOptions {
  /** Lease duration granted on claim. */
  leaseMs?: number;
  /** First retry delay; doubles per attempt. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injectable clock so lease expiry is deterministic in tests. */
  now?: () => Date;
}

interface JobRow {
  id: string;
  run_id: string;
  tenant_id: string;
  kind: string;
  status: string;
  attempts: number;
  max_attempts: number;
  priority: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  available_at: string;
  last_error: string | null;
  payload_json: string | null;
  created_at: string;
  updated_at: string;
}

function parse(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export class DurableQueue {
  private readonly leaseMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly clock: () => Date;

  constructor(
    private readonly driver: SqlDriver,
    options: QueueOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.baseBackoffMs = options.baseBackoffMs ?? 250;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.clock = options.now ?? (() => new Date());
  }

  private toJob(row: JobRow): Job {
    return {
      id: row.id,
      runId: row.run_id,
      tenantId: row.tenant_id,
      kind: row.kind,
      status: row.status as JobStatus,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      priority: Number(row.priority),
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      availableAt: row.available_at,
      lastError: row.last_error,
      payload: parse(row.payload_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async enqueue(input: EnqueueInput): Promise<Job> {
    const at = this.clock();
    const now = at.toISOString();
    const available = new Date(at.getTime() + (input.delayMs ?? 0)).toISOString();
    const id = input.jobId ?? `job_${randomUUID().slice(0, 12)}`;
    await this.driver.execute(
      `INSERT INTO jobs (id, run_id, tenant_id, kind, status, attempts, max_attempts, priority,
                         lease_owner, lease_expires_at, available_at, last_error, payload_json,
                         created_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?)`,
      [
        id,
        input.runId,
        input.tenantId,
        input.kind,
        input.maxAttempts ?? 3,
        input.priority ?? 0,
        available,
        input.payload === undefined ? null : JSON.stringify(input.payload),
        now,
        now,
      ],
    );
    const job = await this.get(id);
    if (!job) throw new Error("Job could not be read back after enqueue");
    return job;
  }

  /**
   * Claim the next claimable job for `owner`. Returns null when the queue is
   * empty, another worker won the race, or the database was locked by another
   * writer (the caller simply polls again).
   */
  async claim(owner: string, options: { leaseMs?: number } = {}): Promise<Job | null> {
    try {
      return await this.claimOnce(owner, options);
    } catch (error) {
      // A contended database is not a failure: the job stays queued and this
      // worker will pick it up on the next poll.
      if (isBusyError(error)) return null;
      throw error;
    }
  }

  private async claimOnce(owner: string, options: { leaseMs?: number } = {}): Promise<Job | null> {
    const at = this.clock();
    const now = at.toISOString();
    const leaseExpiry = new Date(at.getTime() + (options.leaseMs ?? this.leaseMs)).toISOString();

    return this.driver.transaction(async (tx) => {
      const candidate = await tx.queryOne<{ id: string }>(
        `SELECT id FROM jobs
         WHERE status = 'queued' AND available_at <= ?
         ORDER BY priority DESC, created_at ASC
         LIMIT 1`,
        [now],
      );
      if (!candidate) return null;

      const claimed = await tx.execute(
        `UPDATE jobs SET status = 'leased', lease_owner = ?, lease_expires_at = ?,
                         attempts = attempts + 1, updated_at = ?
         WHERE id = ? AND status = 'queued'`,
        [owner, leaseExpiry, now, candidate.id],
      );
      if (claimed === 0) return null;

      const row = await tx.queryOne<JobRow>("SELECT * FROM jobs WHERE id = ?", [candidate.id]);
      return row ? this.toJob(row) : null;
    });
  }

  async get(jobId: string): Promise<Job | null> {
    const row = await this.driver.queryOne<JobRow>("SELECT * FROM jobs WHERE id = ?", [jobId]);
    return row ? this.toJob(row) : null;
  }

  async listByRun(tenantId: string, runId: string): Promise<Job[]> {
    const rows = await this.driver.query<JobRow>(
      "SELECT * FROM jobs WHERE run_id = ? AND tenant_id = ? ORDER BY created_at ASC",
      [runId, tenantId],
    );
    return rows.map((row) => this.toJob(row));
  }

  async listDeadLettered(tenantId: string, limit = 25): Promise<Job[]> {
    const rows = await this.driver.query<JobRow>(
      `SELECT * FROM jobs WHERE tenant_id = ? AND status = 'dead-letter'
       ORDER BY updated_at DESC LIMIT ?`,
      [tenantId, Math.min(Math.max(limit, 1), 100)],
    );
    return rows.map((row) => this.toJob(row));
  }

  /** Extend the lease for work that is still in progress. */
  async heartbeat(jobId: string, owner: string, options: { leaseMs?: number } = {}): Promise<boolean> {
    const at = this.clock();
    const leaseExpiry = new Date(at.getTime() + (options.leaseMs ?? this.leaseMs)).toISOString();
    const changes = await this.driver.execute(
      `UPDATE jobs SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'leased' AND lease_owner = ?`,
      [leaseExpiry, at.toISOString(), jobId, owner],
    );
    return changes > 0;
  }

  /** Mark a job done. Only the current lease owner may complete it. */
  async complete(jobId: string, owner: string): Promise<Job | null> {
    const at = this.clock().toISOString();
    const changes = await this.driver.execute(
      `UPDATE jobs SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
                       updated_at = ?
       WHERE id = ? AND status = 'leased' AND lease_owner = ?`,
      [at, jobId, owner],
    );
    if (changes === 0) return null;
    return this.get(jobId);
  }

  /**
   * Record a failure. The job is re-queued with exponential backoff until its
   * attempt budget is exhausted, then dead-lettered instead of retrying forever.
   */
  async fail(
    jobId: string,
    owner: string,
    error: unknown,
  ): Promise<{ job: Job | null; deadLettered: boolean }> {
    const message = error instanceof Error ? error.message : String(error);
    return this.driver.transaction(async (tx) => {
      const row = await tx.queryOne<JobRow>(
        "SELECT * FROM jobs WHERE id = ? AND status = 'leased' AND lease_owner = ?",
        [jobId, owner],
      );
      if (!row) return { job: null, deadLettered: false };

      const attempts = Number(row.attempts);
      const maxAttempts = Number(row.max_attempts);
      const now = this.clock();
      const deadLettered = attempts >= maxAttempts;
      const backoff = Math.min(this.baseBackoffMs * 2 ** Math.max(0, attempts - 1), this.maxBackoffMs);
      const availableAt = new Date(now.getTime() + backoff).toISOString();

      await tx.execute(
        `UPDATE jobs SET status = ?, lease_owner = NULL, lease_expires_at = NULL,
                         available_at = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
        [
          deadLettered ? "dead-letter" : "queued",
          deadLettered ? row.available_at : availableAt,
          message.slice(0, 500),
          now.toISOString(),
          jobId,
        ],
      );
      const updated = await tx.queryOne<JobRow>("SELECT * FROM jobs WHERE id = ?", [jobId]);
      return { job: updated ? this.toJob(updated) : null, deadLettered };
    });
  }

  /** Cancel every queued or leased job for a run. Returns how many changed. */
  async cancelByRun(tenantId: string, runId: string): Promise<number> {
    const at = this.clock().toISOString();
    return this.driver.execute(
      `UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE run_id = ? AND tenant_id = ? AND status IN ('queued', 'leased')`,
      [at, runId, tenantId],
    );
  }

  /** Whether a run still has queued or leased work. */
  async isRunPending(tenantId: string, runId: string): Promise<boolean> {
    const rows = await this.driver.query<{ count: number }>(
      `SELECT COUNT(*) AS count FROM jobs
       WHERE run_id = ? AND tenant_id = ? AND status IN ('queued', 'leased')`,
      [runId, tenantId],
    );
    return Number(rows[0]?.count ?? 0) > 0;
  }

  /**
   * Return expired leases to the queue. Jobs whose attempt budget is spent move
   * to dead-letter so a crash loop cannot spin forever.
   */
  async recoverStale(options: { limit?: number } = {}): Promise<{ requeued: number; deadLettered: number }> {
    const now = this.clock().toISOString();
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
    return this.driver.transaction(async (tx) => {
      const params: SqlParam[] = [now, limit];
      const stale = await tx.query<{ id: string; attempts: number; max_attempts: number }>(
        `SELECT id, attempts, max_attempts FROM jobs
         WHERE status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
         ORDER BY lease_expires_at ASC LIMIT ?`,
        params,
      );
      let requeued = 0;
      let deadLettered = 0;
      for (const job of stale) {
        if (Number(job.attempts) >= Number(job.max_attempts)) {
          await tx.execute(
            `UPDATE jobs SET status = 'dead-letter', lease_owner = NULL, lease_expires_at = NULL,
                             last_error = COALESCE(last_error, 'lease expired'), updated_at = ?
             WHERE id = ?`,
            [now, job.id],
          );
          deadLettered += 1;
        } else {
          await tx.execute(
            `UPDATE jobs SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
                             available_at = ?, last_error = COALESCE(last_error, 'lease expired'),
                             updated_at = ?
             WHERE id = ?`,
            [now, now, job.id],
          );
          requeued += 1;
        }
      }
      return { requeued, deadLettered };
    });
  }
}

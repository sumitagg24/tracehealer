import { DurableStateStore } from "@/lib/db/state-store";
import type { RunStore } from "@/lib/providers";
import type { AuditEvent, HealResult, RunState, RunSummary } from "@/lib/types";

/**
 * `RunStore` implementation over the durable transactional store.
 *
 * The adapter is bound to one tenant at construction so the pipeline can keep
 * its tenant-free `RunStore` contract while every row it writes is still scoped.
 * When this adapter is selected, run state, transitions, audit events,
 * idempotency keys, and cancellation survive a restart and are shared by every
 * worker pointed at the same database.
 *
 * It never invents a result: `getRun` returns the stored `HealResult` or null,
 * exactly like the filesystem store, so a queued run still reads as "no result
 * yet" rather than as a placeholder report.
 */
export class DurableRunStore implements RunStore {
  readonly id = "durable";

  constructor(
    private readonly state: DurableStateStore,
    private readonly tenantId: string,
  ) {}

  async saveRun(result: HealResult): Promise<void> {
    const existing = await this.state.getRun(this.tenantId, result.id);
    if (!existing) {
      await this.state.createRun({
        tenantId: this.tenantId,
        mode: result.mode,
        traceId: result.traceId,
        idempotencyKey: result.idempotencyKey,
        runId: result.id,
        state: (result.state ?? "healed") as RunState,
        at: result.startedAt,
      });
    }
    await this.state.saveResult(this.tenantId, result);
  }

  async getRun(id: string): Promise<HealResult | null> {
    const record = await this.state.getRun(this.tenantId, id);
    return record?.result ?? null;
  }

  async listRuns(limit = 25): Promise<HealResult[]> {
    const page = await this.state.listRuns(this.tenantId, { limit });
    return page.items
      .map((record) => record.result)
      .filter((value): value is HealResult => value !== null);
  }

  async saveSummary(summary: RunSummary): Promise<void> {
    await this.state.upsertSummary(this.tenantId, summary);
  }

  async getSummary(id: string): Promise<RunSummary | null> {
    const record = await this.state.getRun(this.tenantId, id);
    return record?.summary ?? null;
  }

  async listSummaries(limit = 25): Promise<RunSummary[]> {
    const page = await this.state.listRuns(this.tenantId, { limit });
    return page.items.map((record) => record.summary);
  }

  async updateState(id: string, state: RunState, completedAt: string | null = null): Promise<RunSummary | null> {
    const record = await this.state.getRun(this.tenantId, id);
    if (!record) return null;
    // `upsertSummary` enforces the state machine, so a late progress write can
    // never overwrite a terminal decision such as `cancelled`.
    const summary = await this.state.upsertSummary(this.tenantId, {
      ...record.summary,
      state,
      status: state === "healed" ? "healed" : "needs-review",
      completedAt: completedAt ?? record.summary.completedAt,
    });
    return summary;
  }

  async appendEvent(runId: string, event: AuditEvent): Promise<void> {
    await this.state.appendEvent(this.tenantId, runId, event);
  }

  async readEvents(runId: string): Promise<AuditEvent[]> {
    return this.state.listEvents(this.tenantId, runId);
  }

  async findByIdempotencyKey(key: string): Promise<RunSummary | null> {
    const record = await this.state.findByIdempotencyKey(this.tenantId, key);
    return record?.summary ?? null;
  }
}

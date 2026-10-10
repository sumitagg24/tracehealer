import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSqliteDriver } from "@/lib/db/sqlite";
import { migrate } from "@/lib/db/migrations";
import { DurableStateStore } from "@/lib/db/state-store";

const dirs: string[] = [];

async function tempDb(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "th-db-"));
  dirs.push(dir);
  return path.join(dir, "tracehealer.db");
}

afterEach(async () => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function openStore(file?: string): Promise<{ store: DurableStateStore; file: string }> {
  const target = file ?? (await tempDb());
  const driver = await openSqliteDriver(target);
  const store = await DurableStateStore.open(driver);
  return { store, file: target };
}

describe("prompt 3 — versioned migrations", () => {
  it("applies every migration in order and records them once", async () => {
    const file = await tempDb();
    const driver = await openSqliteDriver(file);
    const first = await migrate(driver);
    expect(first.applied).toEqual([1, 2, 3, 4]);
    expect(first.version).toBe(4);

    const second = await migrate(driver);
    expect(second.applied).toEqual([]);
    expect(second.existing).toEqual([1, 2, 3, 4]);

    const ledger = await driver.query<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations ORDER BY version",
    );
    expect(ledger.map((row) => row.version)).toEqual([1, 2, 3, 4]);
    expect(ledger.map((row) => row.name)).toEqual([
      "core-run-lifecycle",
      "durable-job-queue",
      "artifact-metadata",
      "shared-rate-limit",
    ]);

    const tables = await driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = tables.map((row) => row.name);
    for (const table of [
      "artifacts",
      "audit_events",
      "delivery_attempts",
      "jobs",
      "rate_limit_windows",
      "run_transitions",
      "runs",
      "schema_migrations",
      "tenant_policies",
      "webhook_replays",
    ]) {
      expect(names).toContain(table);
    }
    await driver.close();
  });

  it("does not reapply migrations when a second instance opens the same file", async () => {
    const file = await tempDb();
    const { store } = await openStore(file);
    expect(store.schemaVersion).toBe(4);
    const { store: second } = await openStore(file);
    expect(second.schemaVersion).toBe(4);
    await store.close();
    await second.close();
  });
});

describe("prompt 3 — durable run state", () => {
  it("persists and reads a run back after a simulated restart", async () => {
    const file = await tempDb();
    const first = await openStore(file);
    const created = await first.store.createRun({
      tenantId: "tenant-a",
      mode: "demo",
      traceId: "trace-1",
      runId: "heal_restart",
      at: "2026-01-01T00:00:00.000Z",
    });
    expect(created.deduplicated).toBe(false);
    await first.store.close();

    const second = await openStore(file);
    const reloaded = await second.store.getRun("tenant-a", "heal_restart");
    expect(reloaded?.id).toBe("heal_restart");
    expect(reloaded?.state).toBe("queued");
    expect(reloaded?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    await second.store.close();
  });

  it("deduplicates an idempotency key across two independent instances", async () => {
    const file = await tempDb();
    const a = await openStore(file);
    const b = await openStore(file);

    const first = await a.store.createRun({
      tenantId: "tenant-a",
      mode: "demo",
      traceId: "trace-1",
      idempotencyKey: "incident-2841",
    });
    const duplicate = await b.store.createRun({
      tenantId: "tenant-a",
      mode: "demo",
      traceId: "trace-1",
      idempotencyKey: "incident-2841",
    });

    expect(first.deduplicated).toBe(false);
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.record.id).toBe(first.record.id);

    const scoped = await b.store.findByIdempotencyKey("tenant-b", "incident-2841");
    expect(scoped).toBeNull();

    await a.store.close();
    await b.store.close();
  });

  it("rejects an invalid transition and never resurrects a terminal run", async () => {
    const { store } = await openStore();
    const { record } = await store.createRun({ tenantId: "t", mode: "demo", traceId: "tr" });

    await expect(
      store.transition({ tenantId: "t", runId: record.id, to: "healed" }),
    ).rejects.toThrow(/Invalid run state transition/);

    await store.transition({ tenantId: "t", runId: record.id, to: "reproducing", reason: "started" });
    await store.settle("t", record.id, "cancelled", "cancelled by operator");

    // Cancellation is idempotent …
    const again = await store.settle("t", record.id, "cancelled", "cancelled by operator");
    expect(again.state).toBe("cancelled");
    // … and the run can never be resurrected as healed.
    await expect(
      store.transition({ tenantId: "t", runId: record.id, to: "healed" }),
    ).rejects.toThrow(/Invalid run state transition/);
    await store.close();
  });

  it("keeps an append-only audit trail in order", async () => {
    const { store } = await openStore();
    const { record } = await store.createRun({ tenantId: "t", mode: "demo", traceId: "tr" });
    await store.transition({ tenantId: "t", runId: record.id, to: "reproducing", reason: "reproducing" });
    await store.transition({ tenantId: "t", runId: record.id, to: "diagnosing", reason: "diagnosing" });
    await store.appendEvent("t", record.id, {
      seq: 0,
      at: "2026-01-01T00:00:01.000Z",
      state: "diagnosing",
      message: "trace ingested",
      attempt: 1,
      actor: "orchestrator",
      correlationId: "corr-1",
      detail: { span: "tool.lookup_order" },
    });

    const events = await store.listEvents("t", record.id);
    expect(events.length).toBe(3);
    expect(events.map((event) => event.message)).toEqual(["reproducing", "diagnosing", "trace ingested"]);
    expect(events.every((event, index) => index === 0 || event.seq > events[index - 1].seq)).toBe(true);
    expect(events[2].detail).toEqual({ span: "tool.lookup_order" });

    const transitions = await store.listTransitions("t", record.id);
    expect(transitions.map((t) => t.to)).toEqual(["queued", "reproducing", "diagnosing"]);
    await store.close();
  });

  it("scopes every read to the caller's tenant and pages with a keyset cursor", async () => {
    const { store } = await openStore();
    for (let index = 0; index < 5; index += 1) {
      await store.createRun({
        tenantId: "tenant-a",
        mode: "demo",
        traceId: `trace-${index}`,
        runId: `heal_a${index}`,
        at: `2026-01-0${index + 1}T00:00:00.000Z`,
      });
    }
    await store.createRun({
      tenantId: "tenant-b",
      mode: "demo",
      traceId: "trace-b",
      runId: "heal_b0",
      at: "2026-01-09T00:00:00.000Z",
    });

    const page1 = await store.listRuns("tenant-a", { limit: 2 });
    expect(page1.items.map((item) => item.id)).toEqual(["heal_a4", "heal_a3"]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await store.listRuns("tenant-a", { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((item) => item.id)).toEqual(["heal_a2", "heal_a1"]);

    const page3 = await store.listRuns("tenant-a", { limit: 2, cursor: page2.nextCursor });
    expect(page3.items.map((item) => item.id)).toEqual(["heal_a0"]);
    expect(page3.nextCursor).toBeNull();

    // Another tenant cannot see or read these runs.
    const other = await store.listRuns("tenant-b");
    expect(other.items.map((item) => item.id)).toEqual(["heal_b0"]);
    expect(await store.getRun("tenant-b", "heal_a0")).toBeNull();
    await store.close();
  });

  it("guards webhook replay ids durably across instances", async () => {
    const file = await tempDb();
    const a = await openStore(file);
    const b = await openStore(file);

    expect(await a.store.recordWebhookReplay("neatlogs", "sha256=abc")).toBe(true);
    expect(await b.store.recordWebhookReplay("neatlogs", "sha256=abc")).toBe(false);
    expect(await b.store.recordWebhookReplay("neatlogs", "sha256=def")).toBe(true);
    expect(await a.store.countWebhookReplays()).toBe(2);

    // The replay ledger is prunable independently of run retention.
    expect(await a.store.pruneWebhookReplays("2999-01-01T00:00:00.000Z")).toBe(2);
    expect(await b.store.recordWebhookReplay("neatlogs", "sha256=abc")).toBe(true);

    await a.store.close();
    await b.store.close();
  });

  it("records delivery attempts and tenant policy without leaking across tenants", async () => {
    const { store } = await openStore();
    const { record } = await store.createRun({ tenantId: "t", mode: "demo", traceId: "tr" });
    await store.recordDeliveryAttempt({
      tenantId: "t",
      runId: record.id,
      channel: "github",
      attempt: 1,
      status: "failed",
      error: "502 from provider",
    });
    await store.recordDeliveryAttempt({
      tenantId: "t",
      runId: record.id,
      channel: "github",
      attempt: 2,
      status: "succeeded",
    });

    const attempts = await store.listDeliveryAttempts("t", record.id);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "succeeded"]);
    expect(await store.listDeliveryAttempts("other", record.id)).toEqual([]);

    await store.setTenantPolicy("t", { allowedRepositories: ["northstar/support-agent"] });
    expect(await store.getTenantPolicy("t")).toEqual({
      allowedRepositories: ["northstar/support-agent"],
    });
    expect(await store.getTenantPolicy("other")).toBeNull();
    await store.close();
  });

  it("deletes a run and all derived rows for retention", async () => {
    const { store } = await openStore();
    const old = await store.createRun({
      tenantId: "t",
      mode: "demo",
      traceId: "tr",
      runId: "heal_old",
      at: "2020-01-01T00:00:00.000Z",
    });
    await store.settle("t", old.record.id, "needs-review", "unsupported trace");
    await store.appendEvent("t", old.record.id, {
      seq: 0,
      at: "2020-01-01T00:00:01.000Z",
      state: "needs-review",
      message: "settled",
      attempt: 1,
      actor: "orchestrator",
      correlationId: "corr",
    });
    await store.recordDeliveryAttempt({
      tenantId: "t",
      runId: old.record.id,
      channel: "slack",
      attempt: 1,
      status: "skipped",
    });

    const kept = await store.createRun({
      tenantId: "t",
      mode: "demo",
      traceId: "tr",
      runId: "heal_new",
      at: "2026-01-01T00:00:00.000Z",
    });
    await store.settle("t", kept.record.id, "needs-review", "unsupported trace");

    expect(await store.pruneRuns("t", "2021-01-01T00:00:00.000Z")).toBe(1);
    expect(await store.getRun("t", "heal_old")).toBeNull();
    expect(await store.listEvents("t", "heal_old")).toEqual([]);
    expect(await store.listDeliveryAttempts("t", "heal_old")).toEqual([]);
    expect(await store.getRun("t", "heal_new")).not.toBeNull();

    expect(await store.deleteRun("t", "heal_new")).toBe(true);
    expect(await store.deleteRun("t", "heal_new")).toBe(false);
    await store.close();
  });

  it("reports driver health and schema version", async () => {
    const { store } = await openStore();
    const health = await store.health();
    expect(health.ok).toBe(true);
    expect(health.driver).toBe("sqlite");
    expect(health.schemaVersion).toBe(4);
    expect(store.persistence.dialect).toBe("sqlite");
    await store.close();
  });
});

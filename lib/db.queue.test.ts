import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSqliteDriver } from "@/lib/db/sqlite";
import { DurableQueue } from "@/lib/db/queue";
import { DurableStateStore } from "@/lib/db/state-store";

const dirs: string[] = [];
const open: Array<() => Promise<void>> = [];

async function tempDb(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "th-queue-"));
  dirs.push(dir);
  return path.join(dir, "tracehealer.db");
}

afterEach(async () => {
  // Safety net: release every handle before deleting, even if a test failed.
  while (open.length) {
    const close = open.pop();
    if (close) await close().catch(() => undefined);
  }
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

interface Harness {
  queue: DurableQueue;
  store: DurableStateStore;
  close(): Promise<void>;
  clock: { now: number };
}

async function harness(file?: string, options: { leaseMs?: number } = {}): Promise<Harness> {
  const target = file ?? (await tempDb());
  const clock = { now: Date.parse("2026-01-01T00:00:00.000Z") };
  const driver = await openSqliteDriver(target, { busyTimeoutMs: 40 });
  const state = await DurableStateStore.open(driver, { now: () => new Date(clock.now) });
  const queue = new DurableQueue(driver, {
    leaseMs: options.leaseMs ?? 30_000,
    now: () => new Date(clock.now),
  });
  const close = async () => {
    const index = open.indexOf(close);
    if (index >= 0) open.splice(index, 1);
    await driver.close();
  };
  open.push(close);
  return { queue, store: state, clock, close };
}

describe("prompt 3 — durable job queue", () => {
  it("hands a job to exactly one worker", async () => {
    const h = await harness();
    const job = await h.queue.enqueue({ runId: "heal_1", tenantId: "t", kind: "heal" });

    const claimed = await h.queue.claim("worker-a");
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("leased");
    expect(claimed?.attempts).toBe(1);

    // The same job is not claimable again while it is leased.
    expect(await h.queue.claim("worker-b")).toBeNull();
    await h.close();
  });

  it("lets only one of two competing workers win a claim", async () => {
    const file = await tempDb();
    const a = await harness(file);
    const b = await harness(file);
    await a.queue.enqueue({ runId: "heal_race", tenantId: "t", kind: "heal" });

    const [first, second] = await Promise.all([
      a.queue.claim("worker-a"),
      b.queue.claim("worker-b"),
    ]);
    const winners = [first, second].filter((job) => job !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.attempts).toBe(1);

    const pending = await a.queue.listByRun("t", "heal_race");
    expect(pending.filter((job) => job.status === "leased")).toHaveLength(1);

    await a.close();
    await b.close();
  });

  it("requires the lease owner to complete or renew a job", async () => {
    const h = await harness();
    await h.queue.enqueue({ runId: "heal_1", tenantId: "t", kind: "heal" });
    const claimed = await h.queue.claim("worker-a");
    expect(claimed).not.toBeNull();

    expect(await h.queue.complete(claimed!.id, "worker-b")).toBeNull();
    expect(await h.queue.heartbeat(claimed!.id, "worker-b")).toBe(false);
    // A renewal from the lease owner pushes the expiry out from *now*.
    h.clock.now += 10_000;
    expect(await h.queue.heartbeat(claimed!.id, "worker-a")).toBe(true);
    const renewed = await h.queue.get(claimed!.id);
    expect(Date.parse(renewed!.leaseExpiresAt!)).toBe(h.clock.now + 30_000);

    const completed = await h.queue.complete(claimed!.id, "worker-a");
    expect(completed?.status).toBe("succeeded");
    expect(await h.queue.claim("worker-a")).toBeNull();
    await h.close();
  });

  it("retries with backoff and dead-letters after the attempt budget", async () => {
    const h = await harness();
    await h.queue.enqueue({ runId: "heal_retry", tenantId: "t", kind: "heal", maxAttempts: 3 });

    const first = await h.queue.claim("worker-a");
    const failed = await h.queue.fail(first!.id, "worker-a", new Error("verification crashed"));
    expect(failed.deadLettered).toBe(false);
    expect(failed.job?.status).toBe("queued");
    expect(failed.job?.lastError).toContain("verification crashed");
    // Exponential backoff pushes the retry into the future.
    expect(Date.parse(failed.job!.availableAt)).toBeGreaterThan(h.clock.now);

    h.clock.now += 60_000;
    const second = await h.queue.claim("worker-a");
    expect(second?.attempts).toBe(2);
    const secondFail = await h.queue.fail(second!.id, "worker-a", new Error("still failing"));
    expect(secondFail.deadLettered).toBe(false);

    h.clock.now += 60_000;
    const third = await h.queue.claim("worker-a");
    expect(third?.attempts).toBe(3);
    const thirdFail = await h.queue.fail(third!.id, "worker-a", new Error("gave up"));
    expect(thirdFail.deadLettered).toBe(true);

    // A dead-lettered job is never handed out again.
    h.clock.now += 600_000;
    expect(await h.queue.claim("worker-a")).toBeNull();
    const dead = await h.queue.listDeadLettered("t");
    expect(dead).toHaveLength(1);
    expect(dead[0].status).toBe("dead-letter");
    await h.close();
  });

  it("recovers a stale lease after a worker stops heartbeating", async () => {
    const h = await harness(undefined, { leaseMs: 5_000 });
    await h.queue.enqueue({ runId: "heal_stale", tenantId: "t", kind: "heal", maxAttempts: 3 });
    const claimed = await h.queue.claim("worker-a");
    expect(claimed?.status).toBe("leased");

    // Nothing is recovered while the lease is still valid.
    expect(await h.queue.recoverStale()).toEqual({ requeued: 0, deadLettered: 0 });

    h.clock.now += 6_000;
    expect(await h.queue.recoverStale()).toEqual({ requeued: 1, deadLettered: 0 });

    const reclaimed = await h.queue.claim("worker-b");
    expect(reclaimed?.id).toBe(claimed!.id);
    expect(reclaimed?.attempts).toBe(2);
    expect(reclaimed?.leaseOwner).toBe("worker-b");
    await h.close();
  });

  it("dead-letters a worker that keeps dying without heartbeating", async () => {
    const h = await harness(undefined, { leaseMs: 1_000 });
    await h.queue.enqueue({ runId: "heal_stale", tenantId: "t", kind: "heal", maxAttempts: 2 });

    const first = await h.queue.claim("worker-a");
    expect(first?.attempts).toBe(1);
    h.clock.now += 2_000;
    expect(await h.queue.recoverStale()).toEqual({ requeued: 1, deadLettered: 0 });

    const second = await h.queue.claim("worker-b");
    expect(second?.attempts).toBe(2);
    h.clock.now += 2_000;
    // The attempt budget is spent, so the sweeper dead-letters instead of retrying.
    expect(await h.queue.recoverStale()).toEqual({ requeued: 0, deadLettered: 1 });
    expect((await h.queue.get(second!.id))?.status).toBe("dead-letter");

    h.clock.now += 600_000;
    expect(await h.queue.claim("worker-c")).toBeNull();
    await h.close();
  });

  it("propagates cancellation to queued and leased jobs for a run", async () => {
    const h = await harness();
    await h.queue.enqueue({ runId: "heal_cancel", tenantId: "t", kind: "heal" });
    await h.queue.enqueue({ runId: "heal_cancel", tenantId: "t", kind: "report" });
    await h.queue.enqueue({ runId: "heal_other", tenantId: "t", kind: "heal" });
    const claimed = await h.queue.claim("worker-a");
    expect(claimed).not.toBeNull();

    expect(await h.queue.isRunPending("t", "heal_cancel")).toBe(true);
    expect(await h.queue.cancelByRun("t", "heal_cancel")).toBe(2);
    expect(await h.queue.isRunPending("t", "heal_cancel")).toBe(false);

    const jobs = await h.queue.listByRun("t", "heal_cancel");
    expect(jobs.map((job) => job.status).sort()).toEqual(["cancelled", "cancelled"]);
    // Cancelling twice is a no-op, and the unrelated run is untouched.
    expect(await h.queue.cancelByRun("t", "heal_cancel")).toBe(0);
    expect(await h.queue.claim("worker-a")).toMatchObject({ runId: "heal_other" });
    await h.close();
  });

  it("keeps queue state durable across a restart", async () => {
    const file = await tempDb();
    const first = await harness(file);
    await first.store.createRun({
      tenantId: "t",
      mode: "demo",
      traceId: "tr",
      runId: "heal_restart",
    });
    await first.queue.enqueue({ runId: "heal_restart", tenantId: "t", kind: "heal" });
    const claimed = await first.queue.claim("worker-a");
    expect(claimed?.attempts).toBe(1);
    await first.close();

    const second = await harness(file);
    const reloaded = await second.queue.get(claimed!.id);
    expect(reloaded?.status).toBe("leased");
    expect(reloaded?.leaseOwner).toBe("worker-a");
    expect((await second.store.getRun("t", "heal_restart"))?.state).toBe("queued");
    await second.close();
  });
});

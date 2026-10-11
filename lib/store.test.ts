import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cancelRunSummary, getRunSummary, saveRunSummary } from "@/lib/store";
import type { RunState, RunSummary } from "@/lib/types";

let dir: string | null = null;
let previous: string | undefined;

function summary(id: string, state: RunState): RunSummary {
  return {
    id,
    state,
    status: state === "healed" ? "healed" : "needs-review",
    mode: "demo",
    traceId: "trace-1",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    hasResult: false,
  };
}

beforeEach(async () => {
  previous = process.env.TRACEHEALER_DATA_DIR;
  dir = await mkdtemp(path.join(os.tmpdir(), "th-store-"));
  process.env.TRACEHEALER_DATA_DIR = dir;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.TRACEHEALER_DATA_DIR;
  else process.env.TRACEHEALER_DATA_DIR = previous;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe("run summary finality", () => {
  it("never lets a late write resurrect a terminal run", async () => {
    await saveRunSummary(summary("heal_term", "queued"));
    await saveRunSummary(summary("heal_term", "verifying"));
    await saveRunSummary(summary("heal_term", "cancelled"));

    // A verification step that was already in flight must not overwrite it.
    await saveRunSummary(summary("heal_term", "needs-review"));
    await saveRunSummary(summary("heal_term", "healed"));
    expect((await getRunSummary("heal_term"))?.state).toBe("cancelled");

    // Restating the same terminal state is allowed.
    await saveRunSummary(summary("heal_term", "cancelled"));
    expect((await getRunSummary("heal_term"))?.state).toBe("cancelled");
  });

  it("keeps a terminal decision when two writers race", async () => {
    await saveRunSummary(summary("heal_race", "verifying"));

    // This is the real race: a cancellation and a verification result arriving
    // together. The read-check-write is serialized, so the terminal state wins.
    await Promise.all([
      saveRunSummary(summary("heal_race", "cancelled")),
      saveRunSummary(summary("heal_race", "needs-review")),
    ]);
    expect((await getRunSummary("heal_race"))?.state).toBe("cancelled");
  });

  it("still allows forward progress and delivery retries", async () => {
    await saveRunSummary(summary("heal_forward", "queued"));
    await saveRunSummary(summary("heal_forward", "reproducing"));
    await saveRunSummary(summary("heal_forward", "delivery-failed"));
    await saveRunSummary(summary("heal_forward", "healed"));
    expect((await getRunSummary("heal_forward"))?.state).toBe("healed");
  });

  it("rejects an unsafe run id", async () => {
    await expect(saveRunSummary(summary("../escape", "queued"))).rejects.toThrow(/Unsafe run id/);
  });
});

describe("authoritative cancellation", () => {
  it("replaces the needs-review verdict an aborted pipeline wrote for itself", async () => {
    await saveRunSummary(summary("heal_cancel", "verifying"));
    // The aborted pipeline settles first: this is the interleaving that used to
    // strand a cancelled run as needs-review.
    await saveRunSummary(summary("heal_cancel", "needs-review"));
    expect((await getRunSummary("heal_cancel"))?.state).toBe("needs-review");

    const cancelled = await cancelRunSummary("heal_cancel", "2026-01-02T00:00:00.000Z");
    expect(cancelled?.state).toBe("cancelled");
    expect(cancelled?.completedAt).toBe("2026-01-02T00:00:00.000Z");
    expect((await getRunSummary("heal_cancel"))?.state).toBe("cancelled");

    // The late verdict cannot resurrect the run afterwards.
    await saveRunSummary(summary("heal_cancel", "needs-review"));
    expect((await getRunSummary("heal_cancel"))?.state).toBe("cancelled");
  });

  it("never rewrites a verified healed run", async () => {
    await saveRunSummary(summary("heal_healed", "healed"));
    const after = await cancelRunSummary("heal_healed", "2026-01-02T00:00:00.000Z");
    expect(after?.state).toBe("healed");
  });

  it("leaves a retryable delivery failure and a decided timeout alone", async () => {
    await saveRunSummary(summary("heal_delivery", "delivery-failed"));
    expect((await cancelRunSummary("heal_delivery", "2026-01-02T00:00:00.000Z"))?.state).toBe(
      "delivery-failed",
    );

    await saveRunSummary(summary("heal_timeout", "timed-out"));
    expect((await cancelRunSummary("heal_timeout", "2026-01-02T00:00:00.000Z"))?.state).toBe(
      "timed-out",
    );
  });

  it("is idempotent and keeps the first cancellation timestamp", async () => {
    await saveRunSummary(summary("heal_repeat", "verifying"));
    const first = await cancelRunSummary("heal_repeat", "2026-01-02T00:00:00.000Z");
    const second = await cancelRunSummary("heal_repeat", "2026-01-03T00:00:00.000Z");
    expect(first?.completedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(second?.completedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("returns null for an unknown run", async () => {
    expect(await cancelRunSummary("heal_missing", "2026-01-02T00:00:00.000Z")).toBeNull();
  });
});

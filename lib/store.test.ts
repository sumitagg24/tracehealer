import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getRunSummary, saveRunSummary } from "@/lib/store";
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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDurableStack, resetDurableStack } from "@/lib/db";
import { DEMO_TRACE } from "@/lib/demo-data";
import { computeMetrics } from "@/lib/metrics";
import { awaitHealingRun, getRunProgress, startHealingRun } from "@/lib/runs";

const ENV_KEYS = [
  "TRACEHEALER_STORE",
  "TRACEHEALER_DB_FILE",
  "TRACEHEALER_DATA_DIR",
  "TRACEHEALER_TENANT_ID",
  "TRACEHEALER_RUN_TIMEOUT_MS",
] as const;
const saved: Record<string, string | undefined> = {};
let dir: string | null = null;

beforeEach(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  dir = await mkdtemp(path.join(os.tmpdir(), "th-runstore-"));
  Object.assign(process.env, {
    TRACEHEALER_STORE: "sqlite",
    TRACEHEALER_DATA_DIR: dir,
    TRACEHEALER_DB_FILE: path.join(dir, "tracehealer.db"),
    TRACEHEALER_TENANT_ID: "tenant-a",
  });
  await resetDurableStack();
});

afterEach(async () => {
  await resetDurableStack();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
    else Object.assign(process.env, { [key]: saved[key] });
  }
  await resetDurableStack();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe("prompt 3 — durable run lifecycle", () => {
  it("runs the real pipeline through the durable store and survives a restart", async () => {
    const started = await startHealingRun({
      trace: DEMO_TRACE,
      mode: "demo",
      idempotencyKey: "durable-1",
      tenantId: "tenant-a",
    });
    expect(started.state).toBe("queued");

    const result = await awaitHealingRun(started.runId, "tenant-a");
    expect(result?.state).toBe("healed");
    expect(result?.verification.passed).toBe(true);
    expect(result?.verification.checks).toHaveLength(4);
    expect(result?.artifacts?.beforeTestExitCode).toBe(1);
    expect(result?.artifacts?.afterTestExitCode).toBe(0);

    const progress = await getRunProgress(started.runId, "tenant-a");
    expect(progress?.summary?.state).toBe("healed");
    expect(progress?.events.length).toBeGreaterThan(3);

    // Another tenant sees nothing for the same id.
    expect(await getRunProgress(started.runId, "tenant-b")).toBeNull();

    // Restart: a brand-new process would reopen the same database.
    await resetDurableStack();
    const afterRestart = await getRunProgress(started.runId, "tenant-a");
    expect(afterRestart?.summary?.state).toBe("healed");
    expect(afterRestart?.result?.verification.checks).toHaveLength(4);

    const stack = await getDurableStack();
    const transitions = await stack.state.listTransitions("tenant-a", started.runId);
    expect(transitions[0].to).toBe("queued");
    expect(transitions.at(-1)?.to).toBe("healed");

    // The durable idempotency key still deduplicates after the restart.
    const duplicate = await startHealingRun({
      trace: DEMO_TRACE,
      mode: "demo",
      idempotencyKey: "durable-1",
      tenantId: "tenant-a",
    });
    expect(duplicate.deduplicated).toBe(true);
    expect(duplicate.runId).toBe(started.runId);

    const metrics = await computeMetrics("tenant-a");
    expect(metrics.runCount).toBe(1);
    expect(metrics.healed).toBe(1);
  }, 30_000);
});

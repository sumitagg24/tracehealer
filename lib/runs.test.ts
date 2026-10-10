import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_TRACE } from "@/lib/demo-data";
import { TraceHealerError } from "@/lib/errors";
import { createPipelineDeps, type PatchStrategy, type SandboxProvider } from "@/lib/providers";
import type { SandboxResult } from "@/lib/sandbox";
import { awaitHealingRun, startHealingRun, cancelHealingRun, recoverStaleRuns } from "@/lib/runs";
import { getRunSummary, readRunEvents } from "@/lib/store";

const original = {
  dataDir: process.env.TRACEHEALER_DATA_DIR,
  autoPublish: process.env.AUTO_PUBLISH_DRAFT,
};

function passedSandbox(): SandboxResult {
  const command = { exitCode: 0, stdout: "ok", stderr: "", durationMs: 5 };
  const before = { exitCode: 1, stdout: "fail", stderr: "TypeError", durationMs: 5 };
  return {
    workspaceId: "ws",
    workspacePath: "/tmp/ws",
    patchFile: "/tmp/ws/change.patch",
    reportFile: "/tmp/ws/verification.json",
    appliedFile: "artifacts/ws/applied/order-support.mjs",
    localCommit: "abc1234",
    patch: {
      file: "src/order-support.mjs",
      language: "javascript",
      title: "Handle Order API v3 contact schema",
      rationale: "compat",
      diff: "--- a\n+++ b\n+contact?.primaryEmail\n",
      additions: 10,
      deletions: 1,
    },
    verification: {
      passed: true,
      checks: [{ name: "Replays the exact failed trace input", status: "passed", durationMs: 1 }],
      before: { durationMs: 6842, tokens: 4280, costUsd: 0.0284, errors: 3 },
      after: { durationMs: 820, tokens: 612, costUsd: 0.0041, errors: 0 },
      improvements: { latencyPercent: 88, tokenPercent: 86, costPercent: 86 },
    },
    beforeReproduced: true,
    beforeTest: before,
    afterTest: command,
    beforeReplay: {
      success: false,
      attempts: 3,
      durationMs: 6842,
      tokens: 4280,
      costUsd: 0.0284,
      errors: 3,
      wallClockMs: 12,
      output: null,
      error: "TypeError",
    },
    afterReplay: {
      success: true,
      attempts: 1,
      durationMs: 820,
      tokens: 612,
      costUsd: 0.0041,
      errors: 0,
      wallClockMs: 5,
      output: {},
      error: null,
    },
  };
}

const alwaysStrategy: PatchStrategy = {
  id: "test-strategy",
  reliable: true,
  supports: () => true,
  propose: async () => ({
    file: "src/order-support.mjs",
    content: "export const healed = true;\n",
    title: "Handle Order API v3 contact schema",
    rationale: "compat",
    language: "javascript",
  }),
};

function sandboxFrom(fn: (delayMs: number) => Promise<SandboxResult>, delayMs = 0): SandboxProvider {
  return { id: "test-sandbox", run: () => fn(delayMs) };
}

async function deps(overrides = {}) {
  return createPipelineDeps({
    patchStrategy: alwaysStrategy,
    sandbox: sandboxFrom(async () => passedSandbox()),
    ...overrides,
  });
}

beforeEach(async () => {
  process.env.TRACEHEALER_DATA_DIR = await mkdtemp(path.join(tmpdir(), "tracehealer-runs-"));
  delete process.env.AUTO_PUBLISH_DRAFT;
});

afterEach(() => {
  if (original.dataDir === undefined) delete process.env.TRACEHEALER_DATA_DIR;
  else process.env.TRACEHEALER_DATA_DIR = original.dataDir;
  if (original.autoPublish === undefined) delete process.env.AUTO_PUBLISH_DRAFT;
  else process.env.AUTO_PUBLISH_DRAFT = original.autoPublish;
});

describe("run coordinator", () => {
  it("deduplicates concurrent requests with the same idempotency key", async () => {
    const d = await deps();
    const first = await startHealingRun({ trace: DEMO_TRACE, mode: "demo", idempotencyKey: "key-12345678", deps: d });
    const second = await startHealingRun({ trace: DEMO_TRACE, mode: "demo", idempotencyKey: "key-12345678", deps: d });
    expect(second.deduplicated).toBe(true);
    expect(second.runId).toBe(first.runId);
  });

  it("records needs-review without fabricating an improvement when the strategy fails", async () => {
    const failing: PatchStrategy = { ...alwaysStrategy, propose: async () => { throw new TraceHealerError("verification-failed", "Model returned malformed structured output"); } };
    const d = await deps({ patchStrategy: failing });
    const started = await startHealingRun({ trace: DEMO_TRACE, mode: "demo", deps: d });
    const run = await awaitHealingRun(started.runId);
    expect(run?.status).toBe("needs-review");
    expect(run?.verification.improvements.latencyPercent).toBe(0);
    expect(run?.verification.after).toEqual(run?.verification.before);
  });

  it("keeps a valid verification result when delivery fails", async () => {
    process.env.AUTO_PUBLISH_DRAFT = "true";
    const d = await deps({
      pullRequest: {
        id: "failing-github",
        configured: () => true,
        publish: async () => {
          throw new TraceHealerError("delivery-failed", "GitHub API 403: forbidden");
        },
      },
    });
    const started = await startHealingRun({ trace: DEMO_TRACE, mode: "demo", deps: d });
    const run = await awaitHealingRun(started.runId);
    const summary = await getRunSummary(started.runId);
    expect(run?.verification.passed).toBe(true);
    expect(summary?.state).toBe("delivery-failed");
    expect(run?.delivery?.github).toBe("failed");
  });

  it("marks a green run healed when delivery is unconfigured", async () => {
    const d = await deps();
    const started = await startHealingRun({ trace: DEMO_TRACE, mode: "demo", deps: d });
    await awaitHealingRun(started.runId);
    const summary = await getRunSummary(started.runId);
    expect(summary?.state).toBe("healed");
    expect(summary?.status).toBe("healed");
  });

  it("cancels an in-flight run and records the terminal state", async () => {
    const d = await deps({ sandbox: sandboxFrom(async () => { await new Promise((r) => setTimeout(r, 200)); return passedSandbox(); }) });
    const started = await startHealingRun({ trace: DEMO_TRACE, mode: "demo", deps: d });
    await cancelHealingRun(started.runId);
    await new Promise((r) => setTimeout(r, 400));
    const summary = await getRunSummary(started.runId);
    expect(summary?.state).toBe("cancelled");
  }, 10_000);

  it("times out a slow run", async () => {
    const d = await deps({ sandbox: sandboxFrom(async () => { await new Promise((r) => setTimeout(r, 250)); return passedSandbox(); }) });
    const started = await startHealingRun({ trace: DEMO_TRACE, mode: "demo", deps: d, timeoutMs: 50 });
    await new Promise((r) => setTimeout(r, 500));
    const summary = await getRunSummary(started.runId);
    expect(summary?.state).toBe("timed-out");
  }, 10_000);

  it("writes an append-only audit trail", async () => {
    const d = await deps();
    const started = await startHealingRun({ trace: DEMO_TRACE, mode: "demo", deps: d });
    await awaitHealingRun(started.runId);
    const events = await readRunEvents(started.runId);
    expect(events.length).toBeGreaterThan(2);
    expect(events.some((event) => event.state === "verifying")).toBe(true);
    expect(events.every((event) => event.correlationId.length > 0)).toBe(true);
  }, 10_000);

  it("recovers stale non-terminal runs after a restart", async () => {
    const d = await deps();
    const started = await startHealingRun({ trace: DEMO_TRACE, mode: "demo", deps: d });
    const summary = await getRunSummary(started.runId);
    expect(summary).not.toBeNull();
    const recovered = await recoverStaleRuns([{ ...summary!, state: "verifying" }], new Set());
    expect(recovered[0].state).toBe("needs-review");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEMO_TRACE } from "@/lib/demo-data";
import { TraceHealerError } from "@/lib/errors";
import { healRequestSchema } from "@/lib/schema";
import { canTransition } from "@/lib/run-state";
import { awaitHealingRun, cancelHealingRun, startHealingRun } from "@/lib/runs";
import { getRunSummary } from "@/lib/store";import {
  createPipelineDeps,
  type NotificationProvider,
  type PatchStrategy,
  type PullRequestProvider,
  type SandboxProvider,
} from "@/lib/providers";
import type { SandboxResult } from "@/lib/sandbox";
import type { HealResult, RunState } from "@/lib/types";

/** Deterministic passing sandbox result for terminal-state assertions. */
function passedSandboxResult(): SandboxResult {
  const ok = { exitCode: 0, stdout: "ok", stderr: "", durationMs: 5 };
  const fail = { exitCode: 1, stdout: "fail", stderr: "TypeError", durationMs: 5 };
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
    beforeTest: fail,
    afterTest: ok,
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

const resolvedSandbox: SandboxProvider = {
  id: "resolved-test-sandbox",
  run: async () => passedSandboxResult(),
};

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

/** A sandbox that stays "in flight" until the coordinator aborts it. */
function abortObservingSandbox() {
  let observedAbort = false;
  let entered = false;
  const provider: SandboxProvider = {
    id: "abort-observing-test-sandbox",
    run: ({ signal }) =>
      new Promise((_resolve, reject) => {
        entered = true;
        const fail = () => {
          observedAbort = true;
          reject(new TraceHealerError("cancelled", "Sandbox observed cancellation"));
        };
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener("abort", fail, { once: true });
      }),
  };
  return {
    provider,
    observedAbort: () => observedAbort,
    entered: () => entered,
  };
}

async function waitForState(runId: string, predicate: (state: RunState) => boolean, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const summary = await getRunSummary(runId);
    if (summary && predicate(summary.state)) return summary;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return await getRunSummary(runId);
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return predicate();
}

describe("prompt 1 — explicit request contract", () => {
  it("an empty object no longer silently starts the seeded demo", () => {
    const result = healRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("explicit demo mode is accepted", () => {
    const parsed = healRequestSchema.parse({ mode: "demo" });
    expect(parsed.mode).toBe("demo");
    expect(parsed.trace).toBeUndefined();
  });

  it("connected mode requires a trace", () => {
    expect(healRequestSchema.safeParse({ mode: "connected" }).success).toBe(false);
    const parsed = healRequestSchema.parse({ mode: "connected", trace: DEMO_TRACE });
    expect(parsed.mode).toBe("connected");
    expect(parsed.trace?.id).toBe(DEMO_TRACE.id);
  });

  it("rejects an invalid trace shape under a present mode", () => {
    expect(healRequestSchema.safeParse({ mode: "connected", trace: { bad: true } }).success).toBe(false);
  });
});

describe("prompt 1 — cancellation propagation through the provider boundary", () => {
  const original = {
    dataDir: process.env.TRACEHEALER_DATA_DIR,
    autoPublish: process.env.AUTO_PUBLISH_DRAFT,
  };

  beforeEach(async () => {
    process.env.TRACEHEALER_DATA_DIR = await mkdtemp(path.join(tmpdir(), "tracehealer-p1-"));
    delete process.env.AUTO_PUBLISH_DRAFT;
  });

  afterEach(() => {
    if (original.dataDir === undefined) delete process.env.TRACEHEALER_DATA_DIR;
    else process.env.TRACEHEALER_DATA_DIR = original.dataDir;
    if (original.autoPublish === undefined) delete process.env.AUTO_PUBLISH_DRAFT;
    else process.env.AUTO_PUBLISH_DRAFT = original.autoPublish;
  });

  // These three tests observe real background scheduling (the coordinator and an
  // abort-aware provider), so they get the same explicit budget the HTTP-level
  // suites use instead of the 5s default.
  it("aborts an active run, records cancelled, and performs no commit or delivery", { timeout: 30_000 }, async () => {
    const { provider, observedAbort, entered } = abortObservingSandbox();
    const publishCalls: string[] = [];
    const exportCalls: string[] = [];
    const notifyCalls: string[] = [];

    const pullRequest: PullRequestProvider = {
      id: "never-publish",
      configured: () => true,
      publish: async () => {
        publishCalls.push("publish");
        throw new Error("should not publish");
      },
    };
    const notifications: NotificationProvider = {
      id: "tracking",
      configured: () => true,
      exportTrace: async () => {
        exportCalls.push("export");
        return { status: "not-configured" };
      },
      notify: async () => {
        notifyCalls.push("notify");
        return { status: "not-configured" };
      },
    };

    const deps = createPipelineDeps({
      patchStrategy: alwaysStrategy,
      sandbox: provider,
      pullRequest,
      notifications,
    });

    const started = await startHealingRun({ trace: DEMO_TRACE, mode: "demo", deps });

    // Prove the sandbox is genuinely in flight and the run is at a non-terminal state.
    expect(await waitFor(() => entered())).toBe(true);
    const active = await getRunSummary(started.runId);
    expect(["queued", "reproducing", "diagnosing", "patching", "verifying", "committing"]).toContain(active?.state);
    expect(["healed", "needs-review", "cancelled", "timed-out"]).not.toContain(active?.state);

    const cancelled = await cancelHealingRun(started.runId);
    expect(cancelled?.state).toBe("cancelled");

    // The provider must have observed the abort signal.
    const settled = await waitForState(started.runId, (state) => state === "cancelled");
    expect(observedAbort()).toBe(true);
    expect(settled?.state).toBe("cancelled");

    const run: HealResult | null = await awaitHealingRun(started.runId);
    expect(run?.state).toBe("cancelled");
    expect(run?.status).toBe("needs-review");
    expect(run?.artifacts?.localCommit ?? null).toBeNull();
    expect(run?.delivery?.github ?? "not-configured").not.toBe("published");
    expect(publishCalls).toHaveLength(0);
    expect(exportCalls).toHaveLength(0);
    expect(notifyCalls).toHaveLength(0);

    // A cancelled run is terminal and can never resurrect as healed.
    expect(canTransition("cancelled", "healed")).toBe(false);
    const after = await getRunSummary(started.runId);
    expect(after?.state).toBe("cancelled");
  });

  it("repeated cancellation is idempotent and leaves a terminal run unchanged", { timeout: 30_000 }, async () => {
    const { provider, entered } = abortObservingSandbox();
    const deps = createPipelineDeps({ patchStrategy: alwaysStrategy, sandbox: provider });
    const started = await startHealingRun({ trace: DEMO_TRACE, mode: "demo", deps });

    expect(await waitFor(() => entered())).toBe(true);
    const first = await cancelHealingRun(started.runId);
    // Settle the run before repeating the cancel, so the assertions observe the
    // terminal state rather than a transient progress write.
    await awaitHealingRun(started.runId);
    const settled = await getRunSummary(started.runId);

    const second = await cancelHealingRun(started.runId);
    const third = await cancelHealingRun(started.runId);
    expect(settled?.state).toBe("cancelled");
    expect(first?.state).toBe("cancelled");
    expect(second?.state).toBe("cancelled");
    expect(third?.state).toBe("cancelled");
  });

  it("cancelling an already terminal (healed) run returns its unchanged terminal state", { timeout: 30_000 }, async () => {
    const deps = createPipelineDeps({ patchStrategy: alwaysStrategy, sandbox: resolvedSandbox });
    const started = await startHealingRun({ trace: DEMO_TRACE, mode: "demo", deps });
    await awaitHealingRun(started.runId);

    const before = await getRunSummary(started.runId);
    expect(["healed", "needs-review"]).toContain(before?.state);

    const after = await cancelHealingRun(started.runId);
    expect(after?.state).toBe(before?.state);
  });
});

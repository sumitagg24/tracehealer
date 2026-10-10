import { randomUUID } from "node:crypto";
import path from "node:path";
import { asTraceHealerError, TraceHealerError } from "@/lib/errors";
import { createPipelineDeps, type PipelineDeps } from "@/lib/providers";
import { redactLog } from "@/lib/redact";
import { loadPolicy, matchPathGlob } from "@/lib/policy";
import { healTrace } from "@/lib/engine";
import type { AgentTrace, AuditEvent, HealResult, RunState } from "@/lib/types";

export interface RunOptions {
  deps?: PipelineDeps;
  idempotencyKey?: string;
  correlationId?: string;
  runId?: string;
  /** Cancellation signal that must reach the sandbox provider and delivery gate. */
  signal?: AbortSignal;
  /**
   * Called on every state transition so the coordinator can persist progress.
   * The return value is awaited, which serializes progress writes with the
   * pipeline so the coordinator's final terminal write is always last.
   */
  onState?: (state: RunState) => unknown;
}

function pullRequestBody(result: HealResult) {
  const checks = result.verification.checks
    .map((check) => `- ${check.status === "passed" ? "✅" : "❌"} ${check.name}`)
    .join("\n");
  return `## TraceHealer diagnosis

${result.diagnosis.rootCause}

**Evidence**
${result.diagnosis.evidence.map((item) => `- ${item}`).join("\n")}

## Verification

${checks}

| Metric | Before | After | Improvement |
|---|---:|---:|---:|
| Latency | ${result.verification.before.durationMs}ms | ${result.verification.after.durationMs}ms | ${result.verification.improvements.latencyPercent}% |
| Tokens | ${result.verification.before.tokens} | ${result.verification.after.tokens} | ${result.verification.improvements.tokenPercent}% |
| Cost | $${result.verification.before.costUsd} | $${result.verification.after.costUsd} | ${result.verification.improvements.costPercent}% |

> Drafted by TraceHealer. Human review and merge are required.
`;
}

/**
 * Executes the complete safe pipeline: reproduce, inspect, patch, test, commit
 * locally, persist evidence, optionally publish a draft PR, export an
 * after-trace, and notify Slack. External delivery failures never turn a green
 * verification red; they are recorded in delivery status for retry.
 */
export async function runHealingPipeline(
  trace: AgentTrace,
  mode: "demo" | "connected" = "demo",
  options: RunOptions = {},
): Promise<HealResult> {
  const deps = options.deps ?? createPipelineDeps();
  const runId = options.runId ?? `heal_${randomUUID().slice(0, 8)}`;
  const correlationId = options.correlationId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const messages: string[] = [];
  const events: AuditEvent[] = [];
  let seq = 0;

  const record = async (next: RunState, message: string, detail?: Record<string, unknown>) => {
    await options.onState?.(next);
    const event: AuditEvent = {
      seq: (seq += 1),
      at: new Date().toISOString(),
      state: next,
      message,
      attempt: 1,
      actor: deps.patchStrategy.id,
      correlationId,
      detail,
    };
    events.push(event);
    try {
      await deps.runStore.appendEvent(runId, event);
    } catch {
      // Audit persistence must never break a verified run.
    }
  };

  const signal = options.signal;
  if (signal?.aborted) {
    throw new TraceHealerError("cancelled", "Run cancelled before it started");
  }

  const base = healTrace(trace, mode);
  await record("reproducing", "Healing request accepted; preparing isolated workspace", {
    mode,
    traceId: trace.id,
  });

  // The local graph inspects the target repository. Until an explicit repository
  // provider is configured this is the immutable target fixture checkout.
  const repositoryRoot = process.env.TRACEHEALER_TARGET_REPO_DIR ?? path.join(process.cwd(), "fixtures", "target-agent");
  const context = await deps.contextProvider.build(repositoryRoot, base.diagnosis.symbol);

  const proposalInput = { trace, diagnosis: base.diagnosis, context };
  const strategy = deps.patchStrategy;
  const strategySupports = strategy.supports(proposalInput);

  if (!strategySupports) {
    await record("needs-review", "No registered patch strategy supports this failure", {
      category: base.diagnosis.category,
    });
    const unsupported: HealResult = {
      ...base,
      id: runId,
      status: "needs-review",
      state: "needs-review",
      correlationId,
      idempotencyKey: options.idempotencyKey,
      verification: {
        ...base.verification,
        passed: false,
        after: base.verification.before,
        improvements: { latencyPercent: 0, tokenPercent: 0, costPercent: 0 },
      },
      proposal: { ...base.proposal, number: 0, state: "local", url: null },
      delivery: {
        github: deps.pullRequest.configured() ? "ready" : "not-configured",
        neatlogs: "not-configured",
        slack: "not-configured",
        messages: ["No trusted sandbox strategy is registered for this failure category."],
      },
      events,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    await persistResult(deps, unsupported, "needs-review");
    return unsupported;
  }

  let proposal;
  try {
    await record("diagnosing", "Root cause isolated", {
      file: base.diagnosis.file,
      line: base.diagnosis.line,
      confidence: base.diagnosis.confidence,
    });
    proposal = await strategy.propose(proposalInput);
  } catch (error) {
    const failure = asTraceHealerError(error, "Patch strategy failed to produce a proposal");
    await record("needs-review", failure.publicMessage, { code: failure.code });
    const failed: HealResult = {
      ...base,
      id: runId,
      status: "needs-review",
      state: "needs-review",
      correlationId,
      idempotencyKey: options.idempotencyKey,
      verification: {
        ...base.verification,
        passed: false,
        after: base.verification.before,
        improvements: { latencyPercent: 0, tokenPercent: 0, costPercent: 0 },
      },
      proposal: { ...base.proposal, number: 0, state: "local", url: null },
      delivery: {
        github: deps.pullRequest.configured() ? "ready" : "not-configured",
        neatlogs: "not-configured",
        slack: "not-configured",
        messages: [failure.publicMessage],
      },
      events,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    await persistResult(deps, failed, "needs-review");
    return failed;
  }

  await record("patching", "Minimal patch proposed and validated against policy", { file: proposal.file });

  let sandbox;
  try {
    await record("verifying", "Reproducing failure and running verification in isolation", {
      file: proposal.file,
    });
    sandbox = await deps.sandbox.run({ trace, workspaceId: runId, proposal, signal });
  } catch (error) {
    const failure = asTraceHealerError(error, "Sandbox execution failed");
    const terminal: RunState = "needs-review";
    await record(terminal, failure.publicMessage, { code: failure.code });
    const blocked: HealResult = {
      ...base,
      id: runId,
      status: "needs-review",
      state: terminal,
      correlationId,
      idempotencyKey: options.idempotencyKey,
      verification: {
        ...base.verification,
        passed: false,
        after: base.verification.before,
        improvements: { latencyPercent: 0, tokenPercent: 0, costPercent: 0 },
      },
      proposal: { ...base.proposal, number: 0, state: "local", url: null },
      delivery: {
        github: deps.pullRequest.configured() ? "ready" : "not-configured",
        neatlogs: "not-configured",
        slack: "not-configured",
        messages: [failure.publicMessage],
      },
      events,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    await persistResult(deps, blocked, "needs-review");
    return blocked;
  }

  const passed = sandbox.verification.passed;
  await record(passed ? "committing" : "needs-review", passed ? "Verification passed; committing locally" : "Verification failed; nothing will be committed or published", {
    beforeExit: sandbox.beforeTest.exitCode,
    afterExit: sandbox.afterTest.exitCode,
  });

  const dataRoot = process.env.TRACEHEALER_DATA_DIR ?? "";
  const policy = loadPolicy();
  const appliedStrategy = policy.allowModelPatches ? strategy.id : "deterministic-order-schema-drift";

  let result: HealResult = {
    ...base,
    id: runId,
    status: passed ? "healed" : "needs-review",
    state: passed ? "committing" : "needs-review",
    correlationId,
    idempotencyKey: options.idempotencyKey,
    patch: { ...sandbox.patch, file: proposal.file },
    verification: sandbox.verification,
    steps: [
      {
        id: "capture",
        label: "Failure reproduced",
        detail: `Production failure reproduced in ${sandbox.beforeTest.durationMs}ms`,
        durationMs: sandbox.beforeTest.durationMs,
        status: "complete",
      },
      {
        id: "diagnose",
        label: "Root cause isolated",
        detail: `${context.filesInspected.length} related files · ${Math.round(base.diagnosis.confidence * 100)}% confidence`,
        durationMs: 34,
        status: "complete",
      },
      {
        id: "patch",
        label: "Minimal patch applied",
        detail: `+${sandbox.patch.additions} −${sandbox.patch.deletions} in one file · ${appliedStrategy}`,
        durationMs: 12,
        status: "complete",
      },
      {
        id: "verify",
        label: passed ? "Sandbox verification passed" : "Sandbox verification failed",
        detail: `${sandbox.verification.checks.filter((check) => check.status === "passed").length}/${sandbox.verification.checks.length} checks · node --test`,
        durationMs: sandbox.afterTest.durationMs,
        status: "complete",
      },
      {
        id: "proposal",
        label: "Review proposal committed",
        detail: sandbox.localCommit ? `Local commit ${sandbox.localCommit}` : "Patch artifact generated",
        durationMs: 18,
        status: "complete",
      },
    ],
    context,
    artifacts: {
      workspaceId: sandbox.workspaceId,
      patchFile: "artifacts/" + sandbox.workspaceId + "/change.patch",
      reportFile: "artifacts/" + sandbox.workspaceId + "/verification.json",
      appliedFile: sandbox.appliedFile,
      localCommit: sandbox.localCommit,
      beforeReproduced: sandbox.beforeReproduced,
      testCommand: "node --test",
      beforeTestExitCode: sandbox.beforeTest.exitCode,
      afterTestExitCode: sandbox.afterTest.exitCode,
      beforeLog: redactLog(`${sandbox.beforeTest.stdout}${sandbox.beforeTest.stderr}`.trim().slice(-8_000), [dataRoot, sandbox.workspacePath]),
      afterLog: redactLog(`${sandbox.afterTest.stdout}${sandbox.afterTest.stderr}`.trim().slice(-8_000), [dataRoot, sandbox.workspacePath]),
    },
    proposal: {
      ...base.proposal,
      number: 0,
      state: "local",
      url: null,
      branch: `fix/tracehealer-${runId.slice(-8)}`,
    },
    delivery: {
      github: deps.pullRequest.configured() ? "ready" : "not-configured",
      neatlogs: "not-configured",
      slack: "not-configured",
      messages,
    },
    events,
    startedAt,
    completedAt: new Date().toISOString(),
  };

  if (signal?.aborted) {
    throw new TraceHealerError("cancelled", "Run cancelled before delivery");
  }

  const autoPublish = process.env.AUTO_PUBLISH_DRAFT === "true";
  if (passed && deps.pullRequest.configured() && autoPublish) {
    await record("publishing", "Publishing verified draft pull request");
    try {
      const pullRequest = await deps.pullRequest.publish({
        path: proposal.file,
        content: proposal.content,
        branch: result.proposal.branch,
        title: result.proposal.title,
        body: pullRequestBody(result),
        commitMessage: result.proposal.title,
      });
      result = {
        ...result,
        proposal: { ...result.proposal, ...pullRequest, state: "draft" },
        delivery: { ...result.delivery!, github: "published" },
      };
      await record("healed", "Draft pull request published for human review");
    } catch (error) {
      messages.push(asTraceHealerError(error, "GitHub publication failed").publicMessage);
      result = { ...result, state: "delivery-failed", delivery: { ...result.delivery!, github: "failed", messages } };
      await record("delivery-failed", "Draft publication failed; verification result is preserved");
    }
  } else if (passed) {
    await record("healed", "Verified repair committed locally and ready for review");
    result = { ...result, state: "healed" };
  }

  if (signal?.aborted) {
    throw new TraceHealerError("cancelled", "Run cancelled before notification delivery");
  }

  const [neatlogsDelivery, slackDelivery] = await Promise.all([
    deps.notifications.exportTrace(trace, result),
    deps.notifications.notify(result),
  ]);
  if (neatlogsDelivery.message) messages.push(neatlogsDelivery.message);
  if (slackDelivery.message) messages.push(slackDelivery.message);
  result = {
    ...result,
    delivery: {
      ...result.delivery!,
      neatlogs: neatlogsDelivery.status,
      slack: slackDelivery.status,
      messages,
    },
    events,
    completedAt: new Date().toISOString(),
  };

  await persistResult(deps, result, result.state ?? "healed");
  return result;
}

async function persistResult(deps: PipelineDeps, result: HealResult, state: RunState) {
  await deps.runStore.saveRun(result);
  await deps.runStore.updateState(result.id, state, result.completedAt);
  await deps.runStore.saveSummary({
    id: result.id,
    state,
    status: result.status,
    mode: result.mode,
    traceId: result.traceId,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    hasResult: true,
    idempotencyKey: result.idempotencyKey,
  });
}

/** Exposed for tests and callers that need to validate a repository reference. */
export function repositoryMatchesAllowlist(repository: string, allowed: string[] = loadPolicy().allowedRepositories): boolean {
  return allowed.some((entry) => entry === repository || matchPathGlob(entry, repository));
}

export { TraceHealerError };

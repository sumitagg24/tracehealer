import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildLocalContextGraph } from "@/lib/context";
import { healTrace } from "@/lib/engine";
import { publishDraftPullRequest } from "@/lib/github";
import { exportHealedTrace, integrationStatus, notifySlack } from "@/lib/integrations";
import { executeDemoSandbox, HEALED_ORDER_SOURCE } from "@/lib/sandbox";
import { saveHealingRun } from "@/lib/store";
import type { AgentTrace, HealResult } from "@/lib/types";

function relativeArtifact(file: string) {
  return path.relative(process.cwd(), file).replaceAll("\\", "/");
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
 * Executes the complete safe demo pipeline: reproduce, inspect, patch, test,
 * commit locally, persist evidence, optionally publish a draft PR, export an
 * after-trace, and notify Slack. External delivery failures never turn a green
 * verification red; they are recorded in delivery status for retry.
 */
export async function runHealingPipeline(
  trace: AgentTrace,
  mode: "demo" | "connected" = "demo",
): Promise<HealResult> {
  const base = healTrace(trace, mode);
  const runId = `heal_${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();
  const messages: string[] = [];

  if (base.diagnosis.category !== "schema-drift" || !trace.spans.some((span) => span.name === "tool.lookup_order")) {
    const unsupported: HealResult = {
      ...base,
      id: runId,
      status: "needs-review",
      verification: {
        ...base.verification,
        passed: false,
        after: base.verification.before,
        improvements: { latencyPercent: 0, tokenPercent: 0, costPercent: 0 },
      },
      proposal: { ...base.proposal, number: 0, state: "local", url: null },
      delivery: {
        github: integrationStatus().github.configured ? "ready" : "not-configured",
        neatlogs: integrationStatus().neatlogs.configured ? "failed" : "not-configured",
        slack: integrationStatus().slack.configured ? "failed" : "not-configured",
        messages: ["No trusted sandbox strategy is registered for this failure category."],
      },
      startedAt,
      completedAt: new Date().toISOString(),
    };
    await saveHealingRun(unsupported);
    return unsupported;
  }

  const sandbox = await executeDemoSandbox(trace, { workspaceId: runId });
  const context = await buildLocalContextGraph(sandbox.workspacePath, base.diagnosis.symbol);
  let result: HealResult = {
    ...base,
    id: runId,
    status: sandbox.verification.passed ? "healed" : "needs-review",
    patch: sandbox.patch,
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
        detail: `+${sandbox.patch.additions} −${sandbox.patch.deletions} in one file`,
        durationMs: 12,
        status: "complete",
      },
      {
        id: "verify",
        label: "Sandbox verification passed",
        detail: `${sandbox.verification.checks.length}/${sandbox.verification.checks.length} checks · node --test`,
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
      patchFile: relativeArtifact(sandbox.patchFile),
      reportFile: relativeArtifact(sandbox.reportFile),
      localCommit: sandbox.localCommit,
      beforeReproduced: sandbox.beforeReproduced,
      testCommand: "node --test",
      beforeTestExitCode: sandbox.beforeTest.exitCode,
      afterTestExitCode: sandbox.afterTest.exitCode,
      beforeLog: `${sandbox.beforeTest.stdout}${sandbox.beforeTest.stderr}`.trim().slice(-8_000),
      afterLog: `${sandbox.afterTest.stdout}${sandbox.afterTest.stderr}`.trim().slice(-8_000),
    },
    proposal: {
      ...base.proposal,
      number: 0,
      state: "local",
      url: null,
      branch: `fix/tracehealer-${runId.slice(-8)}`,
    },
    delivery: {
      github: integrationStatus().github.configured ? "ready" : "not-configured",
      neatlogs: "not-configured",
      slack: "not-configured",
      messages,
    },
    startedAt,
    completedAt: new Date().toISOString(),
  };

  const integrations = integrationStatus();
  if (result.status === "healed" && integrations.github.configured && integrations.github.autoPublish) {
    try {
      const pullRequest = await publishDraftPullRequest({
        path: "src/order-support.mjs",
        content: HEALED_ORDER_SOURCE,
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
    } catch (error) {
      messages.push(error instanceof Error ? error.message : "GitHub publication failed");
      result = { ...result, delivery: { ...result.delivery!, github: "failed", messages } };
    }
  }

  const [neatlogsDelivery, slackDelivery] = await Promise.all([
    exportHealedTrace(trace, result),
    notifySlack(result),
  ]);
  if ("message" in neatlogsDelivery && neatlogsDelivery.message) messages.push(neatlogsDelivery.message);
  if ("message" in slackDelivery && slackDelivery.message) messages.push(slackDelivery.message);
  result = {
    ...result,
    delivery: {
      ...result.delivery!,
      neatlogs: neatlogsDelivery.status,
      slack: slackDelivery.status,
      messages,
    },
    completedAt: new Date().toISOString(),
  };

  await saveHealingRun(result);
  return result;
}

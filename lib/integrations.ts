import type { AgentTrace, HealResult } from "@/lib/types";

export interface IntegrationStatus {
  github: { configured: boolean; autoPublish: boolean };
  neatlogs: { configured: boolean; signedWebhooks: boolean };
  slack: { configured: boolean };
  openai: { configured: boolean; model: string };
  entire: { configured: boolean };
  sandbox: { configured: true; provider: "local-process" };
}

export function integrationStatus(): IntegrationStatus {
  return {
    github: {
      configured: Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO),
      autoPublish: process.env.AUTO_PUBLISH_DRAFT === "true",
    },
    neatlogs: {
      configured: Boolean(process.env.NEATLOGS_EXPORT_URL),
      signedWebhooks: Boolean(process.env.NEATLOGS_WEBHOOK_SECRET),
    },
    slack: { configured: Boolean(process.env.SLACK_WEBHOOK_URL) },
    openai: {
      configured: Boolean(process.env.OPENAI_API_KEY),
      model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
    },
    entire: { configured: Boolean(process.env.ENTIRE_API_URL && process.env.ENTIRE_API_KEY) },
    sandbox: { configured: true, provider: "local-process" },
  };
}

async function postJson(url: string, payload: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Integration returned HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
}

export async function exportHealedTrace(trace: AgentTrace, result: HealResult) {
  const endpoint = process.env.NEATLOGS_EXPORT_URL;
  if (!endpoint) return { status: "not-configured" as const };
  try {
    await postJson(
      endpoint,
      {
        type: "tracehealer.run.verified",
        sourceTraceId: trace.id,
        healingRunId: result.id,
        status: result.status,
        before: result.verification.before,
        after: result.verification.after,
        checks: result.verification.checks,
        patch: { file: result.patch.file, additions: result.patch.additions, deletions: result.patch.deletions },
      },
      process.env.NEATLOGS_API_KEY ? { Authorization: `Bearer ${process.env.NEATLOGS_API_KEY}` } : {},
    );
    return { status: "exported" as const };
  } catch (error) {
    return { status: "failed" as const, message: error instanceof Error ? error.message : "Trace export failed" };
  }
}

export async function notifySlack(result: HealResult) {
  const endpoint = process.env.SLACK_WEBHOOK_URL;
  if (!endpoint) return { status: "not-configured" as const };
  try {
    await postJson(endpoint, {
      text: `TraceHealer ${result.status === "healed" ? "verified a fix" : "needs review"} for ${result.traceId}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*TraceHealer ${result.status}*\n${result.diagnosis.summary}\n\`${result.patch.file}\` · ${result.verification.checks.filter((check) => check.status === "passed").length}/${result.verification.checks.length} checks passed`,
          },
        },
      ],
    });
    return { status: "sent" as const };
  } catch (error) {
    return { status: "failed" as const, message: error instanceof Error ? error.message : "Slack delivery failed" };
  }
}

import { NextResponse } from "next/server";
import { publishDraftPullRequest } from "@/lib/github";
import { HEALED_ORDER_SOURCE } from "@/lib/sandbox";
import { getHealingRun, saveHealingRun } from "@/lib/store";

export const runtime = "nodejs";

function bodyForRun(run: NonNullable<Awaited<ReturnType<typeof getHealingRun>>>) {
  return `## TraceHealer verified repair

${run.diagnosis.rootCause}

### Evidence
${run.diagnosis.evidence.map((item) => `- ${item}`).join("\n")}

### Verification
${run.verification.checks.map((check) => `- ${check.status === "passed" ? "✅" : "❌"} ${check.name}`).join("\n")}

| Metric | Before | After |
|---|---:|---:|
| Latency | ${run.verification.before.durationMs}ms | ${run.verification.after.durationMs}ms |
| Tokens | ${run.verification.before.tokens} | ${run.verification.after.tokens} |
| Cost | $${run.verification.before.costUsd} | $${run.verification.after.costUsd} |

Local sandbox commit: \`${run.artifacts?.localCommit ?? "unavailable"}\`

> TraceHealer only opens drafts. Human review and merge are required.
`;
}

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const run = await getHealingRun(id);
  if (!run) return NextResponse.json({ ok: false, error: "Healing run not found" }, { status: 404 });
  if (run.status !== "healed" || !run.verification.passed || !run.artifacts?.beforeReproduced) {
    return NextResponse.json({ ok: false, error: "Only reproduced and fully verified repairs can be published" }, { status: 409 });
  }
  if (run.proposal.url) return NextResponse.json({ ok: true, run, alreadyPublished: true });

  try {
    const pullRequest = await publishDraftPullRequest({
      path: "src/order-support.mjs",
      content: HEALED_ORDER_SOURCE,
      branch: run.proposal.branch,
      title: run.proposal.title,
      body: bodyForRun(run),
      commitMessage: run.proposal.title,
    });
    const updated = {
      ...run,
      proposal: { ...run.proposal, ...pullRequest, state: "draft" as const },
      delivery: {
        github: "published" as const,
        neatlogs: run.delivery?.neatlogs ?? ("not-configured" as const),
        slack: run.delivery?.slack ?? ("not-configured" as const),
        messages: run.delivery?.messages ?? [],
      },
    };
    await saveHealingRun(updated);
    return NextResponse.json({ ok: true, run: updated });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Draft PR publication failed" },
      { status: 502 },
    );
  }
}

import { NextResponse } from "next/server";
import { assertSameOrigin, jsonError, noStore } from "@/lib/http";
import { authorize } from "@/lib/auth";
import { assertRateLimit } from "@/lib/rate-limit";
import { publishDraftPullRequest } from "@/lib/github";
import { readRun, saveRunForTenant } from "@/lib/run-read";
import { readArtifactRelative } from "@/lib/store";
import type { HealResult } from "@/lib/types";

export const runtime = "nodejs";

function bodyForRun(run: HealResult) {
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

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(request);
    const session = authorize(request, "run:publish");
    await assertRateLimit(`publish:${(await context.params).id}`, { limit: 10, windowMs: 60_000 });
    const { id } = await context.params;
    const run = await readRun(session.tenantId, id);
    if (!run) {
      return NextResponse.json({ ok: false, code: "not-found", error: "Healing run not found" }, { status: 404 });
    }
    if (run.status !== "healed" || !run.verification.passed || !run.artifacts?.beforeReproduced) {
      return NextResponse.json(
        {
          ok: false,
          code: "policy-rejected",
          error: "Only reproduced and fully verified repairs can be published",
        },
        { status: 409 },
      );
    }
    if (run.proposal.url) return NextResponse.json({ ok: true, run, alreadyPublished: true }, { headers: noStore() });

    const content = run.artifacts.appliedFile ? await readArtifactRelative(run.artifacts.appliedFile) : null;
    if (!content) {
      return NextResponse.json(
        { ok: false, code: "not-found", error: "The applied patch artifact is unavailable" },
        { status: 409 },
      );
    }

    const pullRequest = await publishDraftPullRequest({
      path: run.patch.file,
      content,
      branch: run.proposal.branch,
      title: run.proposal.title,
      body: bodyForRun(run),
      commitMessage: run.proposal.title,
    });
    const updated: HealResult = {
      ...run,
      state: "healed",
      proposal: { ...run.proposal, ...pullRequest, state: "draft" },
      delivery: {
        github: "published",
        neatlogs: run.delivery?.neatlogs ?? "not-configured",
        slack: run.delivery?.slack ?? "not-configured",
        messages: run.delivery?.messages ?? [],
      },
    };
    await saveRunForTenant(session.tenantId, updated);
    return NextResponse.json({ ok: true, run: updated }, { headers: noStore() });
  } catch (error) {
    return jsonError(error, noStore());
  }
}

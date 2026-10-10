import { NextResponse } from "next/server";
import { integrationStatus } from "@/lib/integrations";
import { noStore } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Liveness only. Dependency checks live in /api/ready. */
export function GET() {
  const integrations = integrationStatus();
  return NextResponse.json(
    {
      status: "healthy",
      service: "tracehealer",
      version: "0.3.0",
      capabilities: {
        traceIntake: true,
        failureDiagnosis: true,
        repositoryContext: true,
        isolatedReplay: true,
        patchGeneration: true,
        localGitCommit: true,
        asyncRuns: true,
        draftPullRequests: integrations.github.configured,
        afterTraceExport: integrations.neatlogs.configured,
        notifications: integrations.slack.configured,
        persistence: "filesystem",
      },
      timestamp: new Date().toISOString(),
    },
    { headers: noStore() },
  );
}

import { NextResponse } from "next/server";
import { integrationStatus } from "@/lib/integrations";

export function GET() {
  const integrations = integrationStatus();
  return NextResponse.json({
    status: "healthy",
    service: "tracehealer",
    version: "0.2.0",
    mode: integrations.github.configured || integrations.neatlogs.configured ? "connected" : "demo",
    capabilities: {
      traceIntake: true,
      failureDiagnosis: true,
      repositoryContext: true,
      isolatedReplay: true,
      patchGeneration: true,
      localGitCommit: true,
      draftPullRequests: integrations.github.configured,
      afterTraceExport: integrations.neatlogs.configured,
      notifications: integrations.slack.configured,
      persistence: "filesystem",
    },
    timestamp: new Date().toISOString(),
  });
}

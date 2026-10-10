import { mkdir, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { NextResponse } from "next/server";
import { integrationStatus } from "@/lib/integrations";
import { asTraceHealerError } from "@/lib/errors";
import { noStore } from "@/lib/http";
import { loadPolicy } from "@/lib/policy";

/**
 * Single readiness implementation shared by the canonical `/api/ready` route and
 * the `/api/readiness` compatibility alias. Keeping one function guarantees the
 * two routes never drift in status code, payload shape, or headers.
 */
export async function buildReadinessResponse(): Promise<NextResponse> {
  try {
    const policy = loadPolicy();
    const dataRoot = process.env.TRACEHEALER_DATA_DIR ?? path.join(process.cwd(), ".tracehealer-data");
    const probe = path.join(dataRoot, `.ready-${randomUUID()}`);
    await mkdir(dataRoot, { recursive: true });
    await writeFile(probe, "ok", "utf8");
    await rm(probe, { force: true });

    const integrations = integrationStatus();
    return NextResponse.json(
      {
        status: "ready",
        dataRootWritable: true,
        persistence: "filesystem",
        policy: {
          allowlistedRepositories: policy.allowedRepositories,
          allowlistedPatchPaths: policy.allowedPatchPaths,
          modelPatchesEnabled: policy.allowModelPatches,
        },
        integrations: {
          github: integrations.github.configured,
          neatlogs: integrations.neatlogs.configured,
          slack: integrations.slack.configured,
          sandbox: integrations.sandbox.provider,
        },
        timestamp: new Date().toISOString(),
      },
      { headers: noStore() },
    );
  } catch (error) {
    const typed = asTraceHealerError(error, "Readiness check failed");
    return NextResponse.json({ status: "not-ready", ...typed.toPublic() }, { status: 503, headers: noStore() });
  }
}

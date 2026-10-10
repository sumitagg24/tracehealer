import { NextResponse } from "next/server";
import { DEMO_INCIDENT } from "@/lib/demo-data";
import { readHealingRuns } from "@/lib/run-read";
import { jsonError, noStore } from "@/lib/http";
import { authorize } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const session = authorize(request, "run:read");
    const runs = await readHealingRuns(session.tenantId, 1);
    const latest = runs[0];
    return NextResponse.json(
      {
        ok: true,
        incidents: [
          {
            ...DEMO_INCIDENT,
            status: latest?.status === "healed" ? "healed" : DEMO_INCIDENT.status,
            latestHealingRunId: latest?.id ?? null,
          },
        ],
      },
      { headers: noStore() },
    );
  } catch (error) {
    return jsonError(error, noStore());
  }
}

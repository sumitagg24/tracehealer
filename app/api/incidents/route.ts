import { NextResponse } from "next/server";
import { DEMO_INCIDENT } from "@/lib/demo-data";
import { listHealingRuns } from "@/lib/store";
import { jsonError, noStore } from "@/lib/http";
import { authorize } from "@/lib/auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    authorize(request, "run:read");
    const runs = await listHealingRuns(1);
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

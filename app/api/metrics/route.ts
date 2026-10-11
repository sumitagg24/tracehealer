import { NextResponse } from "next/server";
import { jsonError, noStore } from "@/lib/http";
import { computeMetrics } from "@/lib/metrics";
import { authorize } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = authorize(request, "run:read");
    const metrics = await computeMetrics(session.tenantId);
    return NextResponse.json({ ok: true, metrics }, { headers: noStore() });
  } catch (error) {
    return jsonError(error, noStore());
  }
}

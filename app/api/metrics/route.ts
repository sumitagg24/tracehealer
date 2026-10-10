import { NextResponse } from "next/server";
import { jsonError, noStore } from "@/lib/http";
import { computeMetrics } from "@/lib/metrics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const metrics = await computeMetrics();
    return NextResponse.json({ ok: true, metrics }, { headers: noStore() });
  } catch (error) {
    return jsonError(error, noStore());
  }
}

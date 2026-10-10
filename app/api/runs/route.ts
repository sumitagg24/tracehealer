import { NextResponse } from "next/server";
import { listHealingRuns } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requested = Number(searchParams.get("limit") ?? 25);
  const runs = await listHealingRuns(Number.isFinite(requested) ? requested : 25);
  return NextResponse.json({ ok: true, runs, count: runs.length });
}

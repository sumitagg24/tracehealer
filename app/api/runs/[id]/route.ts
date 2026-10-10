import { NextResponse } from "next/server";
import { jsonError, noStore } from "@/lib/http";
import { getHealingRun, getRunSummary, readRunEvents } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const [run, summary, events] = await Promise.all([getHealingRun(id), getRunSummary(id), readRunEvents(id)]);
    if (!run && !summary) {
      return NextResponse.json({ ok: false, code: "not-found", error: "Healing run not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, run, summary, events }, { headers: noStore() });
  } catch (error) {
    return jsonError(error, noStore());
  }
}

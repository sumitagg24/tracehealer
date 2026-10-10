import { NextResponse } from "next/server";
import { jsonError, noStore } from "@/lib/http";
import { readRun, readRunEvents, readRunSummary } from "@/lib/run-read";
import { authorize } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = authorize(_request, "run:read");
    const { id } = await context.params;
    const [run, summary, events] = await Promise.all([
      readRun(session.tenantId, id),
      readRunSummary(session.tenantId, id),
      readRunEvents(session.tenantId, id),
    ]);
    if (!run && !summary) {
      return NextResponse.json({ ok: false, code: "not-found", error: "Healing run not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, run, summary, events }, { headers: noStore() });
  } catch (error) {
    return jsonError(error, noStore());
  }
}

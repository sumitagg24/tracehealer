import { NextResponse } from "next/server";
import { jsonError, noStore } from "@/lib/http";
import { getRunProgress } from "@/lib/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-owned progress: state, audit events, and the finished result if any. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const progress = await getRunProgress(id);
    if (!progress) {
      return NextResponse.json({ ok: false, code: "not-found", error: "Healing run not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, ...progress }, { headers: noStore() });
  } catch (error) {
    return jsonError(error, noStore());
  }
}

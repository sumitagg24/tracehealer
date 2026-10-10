import { NextResponse } from "next/server";
import { assertSameOrigin, jsonError, noStore } from "@/lib/http";
import { cancelHealingRun } from "@/lib/runs";
import { authorize } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertSameOrigin(_request);
    authorize(_request, "run:cancel");
    const { id } = await context.params;
    const summary = await cancelHealingRun(id);
    if (!summary) {
      return NextResponse.json({ ok: false, code: "not-found", error: "Healing run not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, run: summary }, { headers: noStore() });
  } catch (error) {
    return jsonError(error, noStore());
  }
}

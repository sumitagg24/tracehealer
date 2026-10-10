import { NextResponse } from "next/server";
import { getHealingRun } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const run = await getHealingRun(id);
  if (!run) return NextResponse.json({ ok: false, error: "Healing run not found" }, { status: 404 });
  return NextResponse.json({ ok: true, run });
}

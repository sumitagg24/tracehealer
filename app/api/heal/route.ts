import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { DEMO_TRACE } from "@/lib/demo-data";
import { healTrace } from "@/lib/engine";
import { healRequestSchema } from "@/lib/schema";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const raw = await request.json().catch(() => ({}));
    const body = healRequestSchema.parse(raw);
    const result = healTrace(body.trace ?? DEMO_TRACE, body.mode);

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { ok: false, error: "Invalid trace payload", details: error.issues },
        { status: 400 },
      );
    }

    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Healing run failed",
      },
      { status: 422 },
    );
  }
}

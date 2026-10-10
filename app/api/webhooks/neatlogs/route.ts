import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { runHealingPipeline } from "@/lib/pipeline";
import { normalizeTracePayload } from "@/lib/trace-normalizer";

export const runtime = "nodejs";

function validSignature(body: string, received: string | null, secret: string) {
  if (!received) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const normalized = received.replace(/^sha256=/, "");
  if (normalized.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(normalized), Buffer.from(expected));
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const secret = process.env.NEATLOGS_WEBHOOK_SECRET;

  if (secret && !validSignature(rawBody, request.headers.get("x-neatlogs-signature"), secret)) {
    return NextResponse.json({ ok: false, error: "Invalid webhook signature" }, { status: 401 });
  }

  try {
    const event = JSON.parse(rawBody) as { type?: string; trace?: unknown };
    if (event.type && !["trace.failed", "run.failed"].includes(event.type)) {
      return NextResponse.json({ ok: true, ignored: true, reason: `Event ${event.type} is not actionable` });
    }

    const trace = normalizeTracePayload(event.trace ?? event);
    const result = await runHealingPipeline(trace, "connected");

    return NextResponse.json({ ok: true, accepted: true, healingRun: result });
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { ok: false, error: "Webhook does not contain a valid failed trace", details: error.issues },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid webhook payload" },
      { status: 400 },
    );
  }
}

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { jsonError, noStore, readBoundedText } from "@/lib/http";
import { TraceHealerError } from "@/lib/errors";
import { startHealingRun } from "@/lib/runs";
import { findRunByIdempotencyKey } from "@/lib/store";
import { normalizeTracePayload } from "@/lib/trace-normalizer";
import { assertFreshTimestamp, observeDelivery, verifySignature } from "@/lib/webhook";

export const runtime = "nodejs";

/**
 * Failed-trace intake. Accepts native TraceHealer, wrapped events, or OTLP JSON.
 * When a secret is configured the raw body is verified with a constant-time HMAC
 * before parsing. Timestamps are freshness-checked and duplicate deliveries are
 * deduplicated by signature so a retried provider delivery is idempotent.
 */
export async function POST(request: Request) {
  try {
    const rawBody = await readBoundedText(request);
    const secret = process.env.NEATLOGS_WEBHOOK_SECRET;
    const signature = request.headers.get("x-neatlogs-signature");

    if (secret && !verifySignature(rawBody, signature, secret)) {
      return NextResponse.json(
        { ok: false, code: "policy-rejected", error: "Invalid webhook signature" },
        { status: 401, headers: noStore() },
      );
    }

    assertFreshTimestamp(request.headers.get("x-neatlogs-timestamp"));

    // Idempotency: a repeated signed delivery returns the existing run.
    const deliveryKey = signature ? `sig:${signature}` : null;
    if (deliveryKey && (await observeDelivery(deliveryKey))) {
      return NextResponse.json({ ok: true, duplicated: true, ignored: true }, { headers: noStore() });
    }

    const event = JSON.parse(rawBody) as { type?: string; trace?: unknown };
    if (event.type && !["trace.failed", "run.failed"].includes(event.type)) {
      return NextResponse.json(
        { ok: true, ignored: true, reason: `Event ${event.type} is not actionable` },
        { headers: noStore() },
      );
    }

    const trace = normalizeTracePayload(event.trace ?? event);
    const idempotencyKey = signature ? `webhook:${signature}` : undefined;
    if (idempotencyKey) {
      const existing = await findRunByIdempotencyKey(idempotencyKey);
      if (existing) {
        return NextResponse.json(
          { ok: true, accepted: true, deduplicated: true, healingRunId: existing.id, state: existing.state },
          { headers: noStore() },
        );
      }
    }

    const started = await startHealingRun({ trace, mode: "connected", idempotencyKey });
    return NextResponse.json(
      { ok: true, accepted: true, healingRunId: started.runId, state: started.state, deduplicated: started.deduplicated },
      { status: 202, headers: noStore() },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { ok: false, code: "invalid-input", error: "Webhook does not contain a valid failed trace", details: error.issues },
        { status: 400, headers: noStore() },
      );
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { ok: false, code: "invalid-input", error: "Webhook body is not valid JSON" },
        { status: 400, headers: noStore() },
      );
    }
    if (error instanceof TraceHealerError) return jsonError(error, noStore());
    return jsonError(error, noStore());
  }
}

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { DEMO_TRACE } from "@/lib/demo-data";
import { runHealingPipeline } from "@/lib/pipeline";
import { healRequestSchema } from "@/lib/schema";
import {
  assertJsonContentType,
  assertSameOrigin,
  clientIp,
  correlationId,
  enforceRateLimit,
  jsonError,
  noStore,
  readBoundedText,
} from "@/lib/http";
import { getHealingRun, findRunByIdempotencyKey } from "@/lib/store";
import { authorize } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Synchronous entry point: runs the full reproduce → patch → verify → commit
 * pipeline and returns the finished record. The control-center UI uses the
 * asynchronous `/api/runs` endpoint so it can render real server progress.
 */
export async function POST(request: Request) {
  const correlation = correlationId(request);
  try {
    authorize(request, "run:create");
    assertSameOrigin(request);
    enforceRateLimit(`heal:${clientIp(request)}`);
    assertJsonContentType(request);
    const raw = await readBoundedText(request);
    const body = healRequestSchema.parse(raw ? JSON.parse(raw) : {});

    if (body.idempotencyKey) {
      const existing = await findRunByIdempotencyKey(body.idempotencyKey);
      if (existing) {
        const run = await getHealingRun(existing.id);
        if (run) {
          return NextResponse.json(
            { ok: true, result: run, deduplicated: true },
            { headers: noStore({ "x-correlation-id": correlation }) },
          );
        }
      }
    }

    const result = await runHealingPipeline(body.trace ?? DEMO_TRACE, body.mode, {
      correlationId: correlation,
      idempotencyKey: body.idempotencyKey,
    });

    return NextResponse.json(
      { ok: true, result },
      { headers: noStore({ "x-correlation-id": correlation }) },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { ok: false, code: "invalid-input", error: "Invalid trace payload", details: error.issues },
        { status: 400, headers: noStore({ "x-correlation-id": correlation }) },
      );
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { ok: false, code: "invalid-input", error: "Request body is not valid JSON" },
        { status: 400, headers: noStore({ "x-correlation-id": correlation }) },
      );
    }
    return jsonError(error, noStore({ "x-correlation-id": correlation }));
  }
}

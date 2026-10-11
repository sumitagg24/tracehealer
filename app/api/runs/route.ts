import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { DEMO_TRACE } from "@/lib/demo-data";
import {
  assertJsonContentType,
  assertSameOrigin,
  clientIp,
  correlationId,
  jsonError,
  noStore,
  readBoundedText,
} from "@/lib/http";
import { startHealingRun } from "@/lib/runs";
import { healRequestSchema } from "@/lib/schema";
import { readRunSummaries } from "@/lib/run-read";
import { authorize } from "@/lib/auth";
import { assertRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const API_VERSION = "2026-10-01";

/** Paginated, secret-free run index for the audit log and control center. */
export async function GET(request: Request) {
  try {
    const session = authorize(request, "run:read");
    const { searchParams } = new URL(request.url);
    const requestedLimit = Number(searchParams.get("limit") ?? 25);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 25;
    const summaries = await readRunSummaries(session.tenantId, limit);
    return NextResponse.json(
      { ok: true, apiVersion: API_VERSION, runs: summaries, count: summaries.length },
      { headers: noStore() },
    );
  } catch (error) {
    return jsonError(error, noStore());
  }
}

/**
 * Create a healing run and return immediately (202). Progress is real server
 * state: poll `/api/runs/:id/progress`.
 */
export async function POST(request: Request) {
  const correlation = correlationId(request);
  try {
    const session = authorize(request, "run:create");
    assertSameOrigin(request);
    await assertRateLimit(`runs:${clientIp(request)}`);
    assertJsonContentType(request);
    const raw = await readBoundedText(request);
    const body = healRequestSchema.parse(raw ? JSON.parse(raw) : {});

    const started = await startHealingRun({
      trace: body.trace ?? DEMO_TRACE,
      mode: body.mode,
      idempotencyKey: body.idempotencyKey,
      tenantId: session.tenantId,
    });

    return NextResponse.json(
      { ok: true, apiVersion: API_VERSION, runId: started.runId, state: started.state, deduplicated: started.deduplicated },
      { status: started.deduplicated ? 200 : 202, headers: noStore({ "x-correlation-id": correlation }) },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json(
        { ok: false, code: "invalid-input", error: "Invalid run payload", details: error.issues },
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

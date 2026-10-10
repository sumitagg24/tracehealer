import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { asTraceHealerError, TraceHealerError } from "@/lib/errors";

const DEFAULT_MAX_BODY_BYTES = 512 * 1024;

export function maxBodyBytes(): number {
  const configured = Number(process.env.TRACEHEALER_MAX_REQUEST_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_BODY_BYTES;
}

export function correlationId(request: Request): string {
  const supplied = request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id");
  return supplied && /^[a-zA-Z0-9_-]{6,64}$/.test(supplied) ? supplied : randomUUID();
}

export function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "local"
  );
}

/**
 * Same-origin guard for browser-initiated mutations. Server-to-server calls with
 * no Origin header are allowed (they authenticate another way); when an Origin
 * is present it must share the request host or a configured APP_URL origin.
 */
export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new TraceHealerError("policy-rejected", "Cross-origin request rejected");
  }
  const allowed = new Set<string>();
  const host = request.headers.get("host");
  if (host) allowed.add(host);
  const appUrl = process.env.APP_URL;
  if (appUrl) {
    try {
      allowed.add(new URL(appUrl).host);
    } catch {
      // ignore malformed APP_URL
    }
  }
  if (!allowed.has(originHost)) {
    throw new TraceHealerError("policy-rejected", "Cross-origin request rejected", { status: 403 });
  }
}

export function assertJsonContentType(request: Request): void {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new TraceHealerError("invalid-input", "Expected an application/json request body");
  }
}

/** Read a bounded text body, rejecting oversized payloads before parsing. */
export async function readBoundedText(request: Request): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  const limit = maxBodyBytes();
  if (Number.isFinite(declared) && declared > limit) {
    throw new TraceHealerError("invalid-input", "Request body exceeds the size limit");
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > limit) {
    throw new TraceHealerError("invalid-input", "Request body exceeds the size limit");
  }
  return body;
}

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

/** Fixed-window limiter suitable for a single-process deployment. */
export function enforceRateLimit(
  key: string,
  limit = Number(process.env.TRACEHEALER_RATE_LIMIT ?? 30),
  windowMs = 60_000,
): void {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    throw new TraceHealerError("rate-limited", "Too many requests; retry shortly");
  }
}

/** Test helper to reset limiter state between cases. */
export function resetRateLimits(): void {
  buckets.clear();
}

export function jsonError(error: unknown, headers: Record<string, string> = {}): NextResponse {
  const typed = asTraceHealerError(error);
  return NextResponse.json({ ok: false, ...typed.toPublic() }, { status: typed.status, headers });
}

export function noStore(headers: Record<string, string> = {}): Record<string, string> {
  return { "Cache-Control": "no-store", ...headers };
}

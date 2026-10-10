import { createHmac, timingSafeEqual } from "node:crypto";
import { getDurableStackIfEnabled } from "@/lib/db";
import { TraceHealerError } from "@/lib/errors";

/** Constant-time HMAC-SHA256 comparison over the unmodified request body. */
export function verifySignature(rawBody: string, received: string | null, secret: string): boolean {
  if (!received) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const normalized = received.replace(/^sha256=/, "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) return false;
  return timingSafeEqual(Buffer.from(normalized, "hex"), Buffer.from(expected, "hex"));
}

export const DEFAULT_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Reject stale deliveries so a captured webhook cannot be replayed much later.
 * A missing timestamp is allowed unless policy demands one.
 */
export function assertFreshTimestamp(
  header: string | null,
  options: { now?: number; toleranceMs?: number; required?: boolean } = {},
): void {
  const required = options.required ?? process.env.TRACEHEALER_WEBHOOK_REQUIRE_TIMESTAMP === "true";
  if (!header) {
    if (required) throw new TraceHealerError("invalid-input", "Missing webhook timestamp");
    return;
  }
  const timestamp = Number(header);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new TraceHealerError("invalid-input", "Malformed webhook timestamp");
  }
  const now = options.now ?? Date.now();
  const tolerance = options.toleranceMs ?? Number(process.env.TRACEHEALER_WEBHOOK_TOLERANCE_MS ?? DEFAULT_TIMESTAMP_TOLERANCE_MS);
  if (Math.abs(now - timestamp) > tolerance) {
    throw new TraceHealerError("policy-rejected", "Webhook timestamp is outside the accepted window");
  }
}

/**
 * In-memory replay cache. Duplicate deliveries inside the window are reported so
 * the caller can return an idempotent response instead of mutating twice.
 */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly windowMs = 10 * 60 * 1000) {}

  private prune(now: number) {
    for (const [key, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(key);
    }
  }

  /** Returns true when this exact delivery was already observed. */
  observe(key: string, now = Date.now()): boolean {
    this.prune(now);
    if (this.seen.has(key)) return true;
    this.seen.set(key, now + this.windowMs);
    return false;
  }

  clear() {
    this.seen.clear();
  }
}

export const globalReplayGuard = new ReplayGuard();

/**
 * Record a delivery and report whether it was already seen.
 *
 * With the durable store enabled the ledger is shared by every worker, so a
 * signature replayed against a second replica is still recognised as a
 * duplicate. Otherwise the process-local guard is used.
 */
export async function observeDelivery(key: string): Promise<boolean> {
  const stack = await getDurableStackIfEnabled();
  if (stack) {
    const first = await stack.state.recordWebhookReplay("neatlogs", key);
    return !first;
  }
  return globalReplayGuard.observe(key);
}

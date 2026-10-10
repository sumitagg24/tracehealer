import { getDurableStackIfEnabled } from "@/lib/db";
import { DurableRateLimiter } from "@/lib/db/rate-limit";
import { enforceRateLimit } from "@/lib/http";

/**
 * Request rate limiting.
 *
 * When the durable store is enabled the budget is shared by every worker through
 * the database; otherwise the process-local fixed-window limiter is used, which
 * is the correct behaviour for the single-process filesystem mode.
 */

export interface RateLimitOptions {
  limit?: number;
  windowMs?: number;
}

export function rateLimitBudget(): number {
  const configured = Number(process.env.TRACEHEALER_RATE_LIMIT ?? 30);
  return Number.isFinite(configured) && configured > 0 ? configured : 30;
}

export function rateLimitWindowMs(): number {
  const configured = Number(process.env.TRACEHEALER_RATE_WINDOW_MS ?? 60_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
}

export async function assertRateLimit(key: string, options: RateLimitOptions = {}): Promise<void> {
  const limit = options.limit ?? rateLimitBudget();
  const windowMs = options.windowMs ?? rateLimitWindowMs();

  const stack = await getDurableStackIfEnabled();
  if (!stack) {
    enforceRateLimit(key, limit, windowMs);
    return;
  }
  await new DurableRateLimiter(stack.driver).enforce(key, limit, windowMs);
}

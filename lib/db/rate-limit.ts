import type { SqlDriver } from "@/lib/db/driver";
import { TraceHealerError } from "@/lib/errors";

/**
 * Shared, durable fixed-window rate limiter.
 *
 * The counter lives in the database, so every process sharing it enforces one
 * budget — an in-memory limiter would let N replicas each admit the full limit.
 * Each increment runs inside a transaction, so concurrent hits cannot lose a
 * count.
 */

export interface RateLimitWindow {
  bucket: string;
  windowStart: number;
  count: number;
  limit: number;
  resetAt: number;
}

export class DurableRateLimiter {
  constructor(
    private readonly driver: SqlDriver,
    private readonly options: { now?: () => number } = {},
  ) {}

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  /**
   * Count one hit and throw `rate-limited` once the window budget is exceeded.
   * Returns the window state so callers can surface remaining budget.
   */
  async enforce(bucket: string, limit: number, windowMs: number): Promise<RateLimitWindow> {
    const now = this.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;

    return this.driver.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO rate_limit_windows (bucket, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1`,
        [bucket, windowStart],
      );
      const row = await tx.queryOne<{ count: number }>(
        "SELECT count FROM rate_limit_windows WHERE bucket = ? AND window_start = ?",
        [bucket, windowStart],
      );
      const count = Number(row?.count ?? 0);
      const window: RateLimitWindow = {
        bucket,
        windowStart,
        count,
        limit,
        resetAt: windowStart + windowMs,
      };
      if (count > limit) {
        throw new TraceHealerError("rate-limited", "Too many requests; retry shortly", {
          detail: window,
        });
      }
      return window;
    });
  }

  /** Drop counters from windows that have already closed. */
  async prune(before: number): Promise<number> {
    return this.driver.execute("DELETE FROM rate_limit_windows WHERE window_start < ?", [before]);
  }

  async clear(bucket?: string): Promise<number> {
    return bucket
      ? this.driver.execute("DELETE FROM rate_limit_windows WHERE bucket = ?", [bucket])
      : this.driver.execute("DELETE FROM rate_limit_windows");
  }
}

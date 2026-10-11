import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getDurableStack, resetDurableStack } from "@/lib/db";
import { DurableRateLimiter } from "@/lib/db/rate-limit";
import { openSqliteDriver } from "@/lib/db/sqlite";
import { DurableStateStore } from "@/lib/db/state-store";
import { TraceHealerError } from "@/lib/errors";
import { observeDelivery } from "@/lib/webhook";

const dirs: string[] = [];
const ENV_KEYS = ["TRACEHEALER_STORE", "TRACEHEALER_DB_FILE", "TRACEHEALER_DATA_DIR"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  await resetDurableStack();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
    else Object.assign(process.env, { [key]: saved[key] });
  }
  // Close the memoized connection before the temp directory is deleted.
  await resetDurableStack();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "th-rate-"));
  dirs.push(dir);
  return path.join(dir, "tracehealer.db");
}

async function limiter(file: string, now: () => number) {
  const driver = await openSqliteDriver(file);
  await DurableStateStore.open(driver);
  return { limiter: new DurableRateLimiter(driver, { now }), close: () => driver.close() };
}

describe("prompt 3 — shared durable rate limiting", () => {
  it("enforces one budget across independent instances", async () => {
    const file = await tempFile();
    const now = () => Date.parse("2026-01-01T00:00:30.000Z");
    const a = await limiter(file, now);
    const b = await limiter(file, now);

    const first = await a.limiter.enforce("runs:1.2.3.4", 3, 60_000);
    expect(first.count).toBe(1);
    expect(first.resetAt).toBe(Date.parse("2026-01-01T00:01:00.000Z"));

    // The second replica sees the first replica's count, so the budget is shared.
    expect((await b.limiter.enforce("runs:1.2.3.4", 3, 60_000)).count).toBe(2);
    expect((await a.limiter.enforce("runs:1.2.3.4", 3, 60_000)).count).toBe(3);
    await expect(b.limiter.enforce("runs:1.2.3.4", 3, 60_000)).rejects.toThrow(TraceHealerError);
    await expect(b.limiter.enforce("runs:1.2.3.4", 3, 60_000)).rejects.toThrow(/Too many requests/);

    // A different bucket is unaffected.
    expect((await b.limiter.enforce("runs:5.6.7.8", 3, 60_000)).count).toBe(1);

    await a.close();
    await b.close();
  });

  it("resets the counter in the next window and prunes closed windows", async () => {
    const file = await tempFile();
    let clock = Date.parse("2026-01-01T00:00:30.000Z");
    const a = await limiter(file, () => clock);

    await a.limiter.enforce("k", 1, 60_000);
    await expect(a.limiter.enforce("k", 1, 60_000)).rejects.toThrow(/Too many/);

    clock = Date.parse("2026-01-01T00:01:30.000Z");
    expect((await a.limiter.enforce("k", 1, 60_000)).count).toBe(1);

    expect(await a.limiter.prune(Date.parse("2026-01-01T00:01:00.000Z"))).toBe(1);
    expect(await a.limiter.clear()).toBe(1);
    expect((await a.limiter.enforce("k", 1, 60_000)).count).toBe(1);
    await a.close();
  });
});

describe("prompt 3 — durable webhook replay wiring", () => {
  it("uses the shared ledger when the durable store is enabled", async () => {
    const file = await tempFile();
    Object.assign(process.env, {
      TRACEHEALER_STORE: "sqlite",
      TRACEHEALER_DB_FILE: file,
      TRACEHEALER_DATA_DIR: path.dirname(file),
    });

    expect(await observeDelivery("sig:first")).toBe(false);
    // Simulate a second replica: reopen the connection and replay the delivery.
    await resetDurableStack();
    expect(await observeDelivery("sig:first")).toBe(true);
    expect(await observeDelivery("sig:second")).toBe(false);

    const stack = await getDurableStack();
    expect(await stack.state.countWebhookReplays()).toBe(2);
  });

  it("falls back to the process-local guard when the durable store is off", async () => {
    Object.assign(process.env, { TRACEHEALER_STORE: "filesystem" });
    await resetDurableStack();
    expect(await observeDelivery("sig:local")).toBe(false);
    expect(await observeDelivery("sig:local")).toBe(true);
  });
});

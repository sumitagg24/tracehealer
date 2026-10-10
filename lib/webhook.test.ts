import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TraceHealerError } from "@/lib/errors";
import { assertFreshTimestamp, ReplayGuard, verifySignature } from "@/lib/webhook";

describe("webhook verification", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ type: "trace.failed" });
  const signature = createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a correct signature and rejects tampering", () => {
    expect(verifySignature(body, `sha256=${signature}`, secret)).toBe(true);
    expect(verifySignature(`${body} `, `sha256=${signature}`, secret)).toBe(false);
    expect(verifySignature(body, null, secret)).toBe(false);
    expect(verifySignature(body, "sha256=deadbeef", secret)).toBe(false);
  });

  it("rejects stale and malformed timestamps", () => {
    const now = Date.now();
    expect(() => assertFreshTimestamp(String(now), { now, toleranceMs: 1000 })).not.toThrow();
    expect(() => assertFreshTimestamp(String(now - 60_000), { now, toleranceMs: 1000 })).toThrow(TraceHealerError);
    expect(() => assertFreshTimestamp("not-a-number", { now })).toThrow(TraceHealerError);
    expect(() => assertFreshTimestamp(null, { now, required: true })).toThrow(TraceHealerError);
    expect(() => assertFreshTimestamp(null, { now })).not.toThrow();
  });

  it("flags a replayed delivery inside the window", () => {
    const guard = new ReplayGuard(60_000);
    const now = Date.now();
    expect(guard.observe("sig:abc", now)).toBe(false);
    expect(guard.observe("sig:abc", now)).toBe(true);
    expect(guard.observe("sig:def", now)).toBe(false);
  });
});

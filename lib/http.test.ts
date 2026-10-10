import { afterEach, describe, expect, it } from "vitest";
import { TraceHealerError } from "@/lib/errors";
import {
  assertJsonContentType,
  assertSameOrigin,
  correlationId,
  enforceRateLimit,
  jsonError,
  maxBodyBytes,
  readBoundedText,
  resetRateLimits,
} from "@/lib/http";

function request(headers: Record<string, string>, body = ""): Request {
  return new Request("http://localhost:3000/api/heal", { method: "POST", headers, body });
}

afterEach(() => resetRateLimits());

describe("http hardening", () => {
  it("accepts same-origin mutations and rejects cross-origin ones", () => {
    expect(() => assertSameOrigin(request({ origin: "http://localhost:3000", host: "localhost:3000" }))).not.toThrow();
    expect(() => assertSameOrigin(request({ origin: "https://evil.example", host: "localhost:3000" }))).toThrow(
      TraceHealerError,
    );
    expect(() => assertSameOrigin(request({}))).not.toThrow();
  });

  it("requires a JSON content type", () => {
    expect(() => assertJsonContentType(request({ "content-type": "application/json" }))).not.toThrow();
    expect(() => assertJsonContentType(request({ "content-type": "text/plain" }))).toThrow(TraceHealerError);
  });

  it("rejects oversized bodies before parsing", async () => {
    const huge = "x".repeat(maxBodyBytes() + 1);
    await expect(readBoundedText(request({ "content-type": "application/json" }, huge))).rejects.toThrow(
      TraceHealerError,
    );
    const ok = await readBoundedText(request({ "content-type": "application/json" }, "{}"));
    expect(ok).toBe("{}");
  });

  it("rate limits per key", () => {
    enforceRateLimit("k", 2, 60_000);
    enforceRateLimit("k", 2, 60_000);
    expect(() => enforceRateLimit("k", 2, 60_000)).toThrow(/Too many/);
  });

  it("returns safe JSON errors and derives a correlation id", async () => {
    const response = jsonError(new TraceHealerError("unconfigured", "Not configured", { detail: "internal secret" }));
    expect(response.status).toBe(503);
    const payload = (await response.json()) as { code: string; error: string };
    expect(payload).toEqual({ ok: false, code: "unconfigured", error: "Not configured" });
    expect(JSON.stringify(payload)).not.toContain("internal secret");
    expect(correlationId(request({ "x-request-id": "abc123def456" }))).toBe("abc123def456");
    expect(correlationId(request({}))).toMatch(/[a-f0-9-]{36}/);
  });
});

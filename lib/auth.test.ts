import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertTenant,
  authorize,
  createSession,
  issueSessionToken,
  localSession,
  readSessionToken,
  requireCapability,
  requireSession,
  SESSION_COOKIE_NAME,
} from "@/lib/auth";
import { TraceHealerError } from "@/lib/errors";
import { assertSameOrigin } from "@/lib/http";

const KEYS = [
  "TRACEHEALER_AUTH_MODE",
  "TRACEHEALER_SESSION_SECRET",
  "TRACEHEALER_LOCAL_AUTH_ACK",
  "NODE_ENV",
] as const;

const saved: Record<string, string | undefined> = {};

/** `process.env.NODE_ENV` is declared readonly by the Next.js types. */
function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else Object.assign(process.env, { [key]: value });
  }
}

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  setEnv(saved);
});

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost:3000/api/runs", { method: "POST", headers });
}

describe("prompt 2 — local (development-only) authentication", () => {
  it("defaults to a local admin session with all capabilities", () => {
    setEnv({ TRACEHEALER_AUTH_MODE: undefined, NODE_ENV: "test" });
    const session = requireSession(request());
    expect(session.role).toBe("admin");
    expect(localSession().tenantId).toBe("local");
    for (const capability of ["run:read", "run:create", "run:cancel", "policy:write"] as const) {
      expect(() => requireCapability(session, capability)).not.toThrow();
    }
  });

  it("fails closed in a production runtime without an explicit acknowledgement", () => {
    setEnv({
      TRACEHEALER_AUTH_MODE: undefined,
      TRACEHEALER_LOCAL_AUTH_ACK: undefined,
      NODE_ENV: "production",
    });
    expect(() => requireSession(request())).toThrow(TraceHealerError);
    expect(() => requireSession(request())).toThrow(/development-only/);
  });

  it("allows an explicitly acknowledged local runtime", () => {
    setEnv({ NODE_ENV: "production", TRACEHEALER_LOCAL_AUTH_ACK: "true" });
    expect(requireSession(request()).role).toBe("admin");
  });
});

describe("prompt 2 — session authentication", () => {
  beforeEach(() => {
    process.env.TRACEHEALER_AUTH_MODE = "session";
  });

  it("fails closed when the session secret is not configured", () => {
    delete process.env.TRACEHEALER_SESSION_SECRET;
    expect(() => requireSession(request())).toThrow(/not configured/);
  });

  it("rejects an unauthenticated request with 401", () => {
    process.env.TRACEHEALER_SESSION_SECRET = "secret";
    try {
      requireSession(request());
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TraceHealerError);
      expect((error as TraceHealerError).status).toBe(401);
      expect((error as TraceHealerError).code).toBe("unauthorized");
    }
  });

  it("accepts a valid session cookie and enforces role capabilities", () => {
    const secret = "secret-value";
    process.env.TRACEHEALER_SESSION_SECRET = secret;
    const operator = createSession({ role: "operator" });
    const token = issueSessionToken(operator, secret);
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${token}` };

    expect(authorize(request(headers), "run:create").role).toBe("operator");
    try {
      authorize(request(headers), "policy:write");
      throw new Error("expected throw");
    } catch (error) {
      expect((error as TraceHealerError).code).toBe("forbidden");
      expect((error as TraceHealerError).status).toBe(403);
    }
  });

  it("gives a viewer read-only access", () => {
    const secret = "secret-value";
    process.env.TRACEHEALER_SESSION_SECRET = secret;
    const viewer = createSession({ role: "viewer" });
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${issueSessionToken(viewer, secret)}` };

    expect(authorize(request(headers), "run:read").role).toBe("viewer");
    expect(() => authorize(request(headers), "run:create")).toThrow(/role/);
  });

  it("rejects an expired session", () => {
    const secret = "secret-value";
    process.env.TRACEHEALER_SESSION_SECRET = secret;
    const expired = createSession({ expiresAt: Date.now() - 1_000 });
    const token = issueSessionToken(expired, secret);
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${token}` };
    expect(() => requireSession(request(headers), Date.now())).toThrow(/Authentication required/);
  });

  it("rejects a tampered token", () => {
    const secret = "secret-value";
    process.env.TRACEHEALER_SESSION_SECRET = secret;
    const token = issueSessionToken(createSession({ role: "admin" }), secret);
    const [payload] = token.split(".");
    const forged = `${payload}.deadbeefdeadbeefdeadbeef`;
    expect(readSessionToken(forged, secret)).toBeNull();
  });
});

describe("prompt 2 — tenant authorization and CSRF", () => {
  it("treats a cross-tenant resource as not-found to prevent enumeration", () => {
    const session = createSession({ tenantId: "tenant-a" });
    expect(() => assertTenant(session, "tenant-a")).not.toThrow();
    try {
      assertTenant(session, "tenant-b");
      throw new Error("expected throw");
    } catch (error) {
      expect((error as TraceHealerError).code).toBe("not-found");
      expect((error as TraceHealerError).status).toBe(404);
    }
  });

  it("rejects a cookie-authenticated mutation from a foreign origin", () => {
    process.env.TRACEHEALER_SESSION_SECRET = "secret-value";
    process.env.TRACEHEALER_AUTH_MODE = "session";
    const token = issueSessionToken(createSession({ role: "operator" }), "secret-value");
    const crossOrigin = new Request("http://localhost:3000/api/runs", {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, origin: "https://evil.example", host: "localhost:3000" },
    });
    expect(() => assertSameOrigin(crossOrigin)).toThrow(/Cross-origin/);
  });
});

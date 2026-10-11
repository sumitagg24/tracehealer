import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { TraceHealerError } from "@/lib/errors";

/**
 * Authentication and authorization boundary.
 *
 * Two modes:
 *  - `local`  (default): development-only. Provides a synthetic admin principal
 *             so the zero-secret demo keeps working. It REFUSES to run in a
 *             production runtime unless `TRACEHEALER_LOCAL_AUTH_ACK=true`.
 *  - `session`: production mode. Requires `TRACEHEALER_SESSION_SECRET` and a
 *             valid HMAC-signed, HTTP-only, SameSite session cookie. Fails
 *             closed (503) when the secret is missing, and 401 without a valid
 *             session.
 */

export type Role = "viewer" | "operator" | "admin";

export type Capability =
  | "run:read"
  | "run:create"
  | "run:cancel"
  | "run:publish"
  | "run:retry"
  | "policy:write"
  | "integration:write";

const ROLE_CAPABILITIES: Record<Role, Capability[]> = {
  viewer: ["run:read"],
  operator: ["run:read", "run:create", "run:cancel", "run:publish", "run:retry"],
  admin: [
    "run:read",
    "run:create",
    "run:cancel",
    "run:publish",
    "run:retry",
    "policy:write",
    "integration:write",
  ],
};

export interface Session {
  sessionId: string;
  tenantId: string;
  workspaceId: string;
  userId: string;
  role: Role;
  expiresAt: number;
}

export type AuthMode = "local" | "session";

export const SESSION_COOKIE_NAME = "tracehealer_session";

export function authMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  return env.TRACEHEALER_AUTH_MODE?.toLowerCase() === "session" ? "session" : "local";
}

export function isProductionRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === "production";
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Create a signed session token for the session cookie. */
export function issueSessionToken(session: Session, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** Verify and decode a signed session token, rejecting tampering and expiry. */
export function readSessionToken(token: string | null, secret: string, now = Date.now()): Session | null {
  if (!token || !secret) return null;
  const [payload, signature, ...rest] = token.split(".");
  if (!payload || !signature || rest.length > 0) return null;
  const expected = sign(payload, secret);
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    if (!session?.tenantId || !session?.role || typeof session.expiresAt !== "number") return null;
    if (session.expiresAt <= now) return null;
    return session;
  } catch {
    return null;
  }
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** Build the development-only synthetic admin principal. */
export function localSession(): Session {
  return {
    sessionId: "local-session",
    tenantId: process.env.TRACEHEALER_TENANT_ID ?? "local",
    workspaceId: process.env.TRACEHEALER_WORKSPACE_ID ?? "local",
    userId: "local-operator",
    role: "admin",
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

/** Resolve a session or throw a typed, fail-closed error. */
export function requireSession(request: Request, now = Date.now()): Session {
  if (authMode() === "local") {
    if (isProductionRuntime() && process.env.TRACEHEALER_LOCAL_AUTH_ACK !== "true") {
      throw new TraceHealerError(
        "unconfigured",
        "Local authentication is development-only and is disabled in a production runtime. Configure TRACEHEALER_AUTH_MODE=session with TRACEHEALER_SESSION_SECRET.",
      );
    }
    return localSession();
  }

  const secret = process.env.TRACEHEALER_SESSION_SECRET;
  if (!secret) {
    throw new TraceHealerError("unconfigured", "Session authentication is not configured");
  }
  const session = readSessionToken(cookieValue(request, SESSION_COOKIE_NAME), secret, now);
  if (!session) {
    throw new TraceHealerError("unauthorized", "Authentication required");
  }
  return session;
}

/** Least-privilege capability check. */
export function requireCapability(session: Session, capability: Capability): void {
  if (!ROLE_CAPABILITIES[session.role].includes(capability)) {
    throw new TraceHealerError("forbidden", "Your role does not permit this action");
  }
}

/**
 * Tenant scoping. A resource that does not belong to the caller's tenant is
 * reported as not-found so run/artifact identifiers cannot be enumerated
 * across tenants.
 */
export function assertTenant(session: Session, tenantId: string): void {
  if (session.tenantId !== tenantId) {
    throw new TraceHealerError("not-found", "Resource not found");
  }
}

/** Convenience: resolve a session and assert a capability in one call. */
export function authorize(request: Request, capability: Capability, now = Date.now()): Session {
  const session = requireSession(request, now);
  requireCapability(session, capability);
  return session;
}

/** Test/ops helper for minting a short-lived session. */
export function createSession(overrides: Partial<Session> = {}, ttlMs = 60 * 60 * 1000): Session {
  return {
    sessionId: `sess_${randomUUID().slice(0, 8)}`,
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
    userId: "user-1",
    role: "operator",
    expiresAt: Date.now() + ttlMs,
    ...overrides,
  };
}

export const CAPABILITIES_BY_ROLE = ROLE_CAPABILITIES;

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as configGet } from "@/app/api/desktop/auth/config/route";
import { GET as authorizeGet } from "@/app/api/desktop/auth/authorize/route";
import { POST as tokenPost } from "@/app/api/desktop/auth/token/route";
import { GET as sessionGet } from "@/app/api/desktop/session/route";
import {
  AUTHORIZE_PARAMS,
  buildAuthorizeUrl,
  desktopAuthConfig,
  DESKTOP_REDIRECT_URI,
  exchangeAuthorizationCode,
  providerConfigured,
} from "@/lib/desktop-auth";
import { issueSessionToken, SESSION_COOKIE_NAME, type Session } from "@/lib/auth";
import { resetRateLimits } from "@/lib/http";

const OIDC_KEYS = [
  "TRACEHEALER_OIDC_AUTHORIZE_URL",
  "TRACEHEALER_OIDC_TOKEN_URL",
  "TRACEHEALER_OIDC_CLIENT_ID",
  "TRACEHEALER_OIDC_SCOPES",
  "TRACEHEALER_OIDC_PROVIDER",
  "TRACEHEALER_OIDC_CLIENT_SECRET",
] as const;

const saved: Record<string, string | undefined> = {};

function configureProvider(overrides: Record<string, string> = {}) {
  process.env.TRACEHEALER_OIDC_AUTHORIZE_URL = "https://idp.example/authorize";
  process.env.TRACEHEALER_OIDC_TOKEN_URL = "https://idp.example/token";
  process.env.TRACEHEALER_OIDC_CLIENT_ID = "tracehealer-desktop";
  process.env.TRACEHEALER_OIDC_SCOPES = "openid profile";
  process.env.TRACEHEALER_OIDC_PROVIDER = "corp-oidc";
  process.env.TRACEHEALER_OIDC_CLIENT_SECRET = "server-side-secret";
  Object.assign(process.env, overrides);
}

const STATE = "s".repeat(43);
const NONCE = "n".repeat(43);
const CHALLENGE = "c".repeat(43);

function authorizeRequest(query: Record<string, string> = {}): Request {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: "tracehealer-desktop",
    redirect_uri: DESKTOP_REDIRECT_URI,
    state: STATE,
    nonce: NONCE,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "openid profile",
    ...query,
  });
  return new Request(`http://localhost:3000/api/desktop/auth/authorize?${params}`, {
    headers: { host: "localhost:3000" },
  });
}

function tokenRequest(body: Record<string, string>, headers: Record<string, string> = {}): Request {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: "auth-code-1",
    code_verifier: "v".repeat(43),
    client_id: "tracehealer-desktop",
    redirect_uri: DESKTOP_REDIRECT_URI,
    ...body,
  });
  return new Request("http://localhost:3000/api/desktop/auth/token", {
    method: "POST",
    headers: {
      host: "localhost:3000",
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: form.toString(),
  });
}

beforeEach(() => {
  for (const key of OIDC_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  delete process.env.APP_URL;
  resetRateLimits();
});

afterEach(() => {
  for (const key of OIDC_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});

describe("desktop provider boundary", () => {
  it("fails closed when no provider is configured", async () => {
    expect(providerConfigured()).toBe(false);
    const response = await configGet(new Request("http://localhost:3000/api/desktop/auth/config"));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload.configured).toBe(false);
    expect(payload.authorizeEndpoint).toBe("");
    expect(payload.tokenEndpoint).toBe("");
    expect(String(payload.reason)).toContain("not configured");
    // Nothing about the provider is disclosed when there is none.
    const body = JSON.stringify(payload);
    expect(body).not.toContain("idp.example");
    expect(body).not.toContain("secret");
  });

  it("advertises same-origin endpoints and never the client secret", async () => {
    configureProvider();
    expect(providerConfigured()).toBe(true);
    const payload = desktopAuthConfig(new Request("https://app.example/api/desktop/auth/config"));
    expect(payload.configured).toBe(true);
    expect(payload.provider).toBe("corp-oidc");
    expect(payload.clientId).toBe("tracehealer-desktop");
    // Same origin as the deployment, so the desktop's origin pin holds.
    expect(payload.authorizeEndpoint).toBe("https://app.example/api/desktop/auth/authorize");
    expect(payload.tokenEndpoint).toBe("https://app.example/api/desktop/auth/token");
    expect(JSON.stringify(payload)).not.toContain("server-side-secret");
    // The provider's own URLs are not handed to the desktop at all.
    expect(JSON.stringify(payload)).not.toContain("idp.example");
  });

  it("uses APP_URL when a proxy fronts the deployment", () => {
    configureProvider();
    process.env.APP_URL = "https://public.example";
    const payload = desktopAuthConfig(new Request("http://internal:3000/api/desktop/auth/config"));
    expect(payload.authorizeEndpoint).toBe("https://public.example/api/desktop/auth/authorize");
  });
});

describe("authorize redirect", () => {
  it("redirects to the configured provider with only allowlisted parameters", () => {
    configureProvider();
    const location = buildAuthorizeUrl(authorizeRequest());
    const target = new URL(location);
    expect(target.origin).toBe("https://idp.example");
    expect(target.pathname).toBe("/authorize");
    for (const name of AUTHORIZE_PARAMS) {
      expect(target.searchParams.get(name)).toBeTruthy();
    }
    // An extra parameter the desktop never sends is not forwarded.
    const withExtra = new URL(authorizeRequest({ next: "https://evil.example" }).url);
    expect(new URL(buildAuthorizeUrl(new Request(withExtra.toString()))).searchParams.get("next")).toBeNull();
  });

  it("refuses malformed or downgraded requests", async () => {
    configureProvider();
    const malformed: Array<Record<string, string>> = [
      { response_type: "token" },
      { code_challenge_method: "plain" },
      { code_challenge: "short" },
      { state: "tiny" },
      { nonce: "" },
      { redirect_uri: "https://evil.example/callback" },
    ];
    for (const query of malformed) {
      const response = await authorizeGet(authorizeRequest(query));
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { code?: string };
      expect(payload.code).toBe("invalid-input");
    }
  });

  it("is unavailable rather than redirecting anywhere when unconfigured", async () => {
    const response = await authorizeGet(authorizeRequest());
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
  });

  it("never becomes an open redirect", async () => {
    configureProvider({ TRACEHEALER_OIDC_AUTHORIZE_URL: "https://idp.example/authorize?tenant=acme" });
    const location = buildAuthorizeUrl(
      authorizeRequest({ redirect_uri: DESKTOP_REDIRECT_URI }),
    );
    expect(new URL(location).origin).toBe("https://idp.example");
    expect(new URL(location).searchParams.get("tenant")).toBe("acme");
  });
});

describe("server-side token exchange", () => {
  it("posts the code and verifier to the provider and relays the response", async () => {
    configureProvider();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://idp.example/token");
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("code")).toBe("auth-code-1");
      expect(form.get("code_verifier")).toBe("v".repeat(43));
      expect(form.get("redirect_uri")).toBe(DESKTOP_REDIRECT_URI);
      // The confidential client's secret is added here, server-side only.
      expect(form.get("client_secret")).toBe("server-side-secret");
      return new Response(JSON.stringify({ access_token: "tok_abcdefghijklmnop", expires_in: 900 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await tokenPost(tokenRequest({}));
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { access_token?: string };
    expect(payload.access_token).toBe("tok_abcdefghijklmnop");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The relayed body must not echo the secret back to the client.
    expect(JSON.stringify(payload)).not.toContain("server-side-secret");
  });

  it("never relays the provider's response body through an error", async () => {
    configureProvider();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("provider said: secret 9f3a1c", { status: 400 })),
    );
    const failedProvider = await tokenPost(tokenRequest({}));
    // The provider's body is relayed as data (the desktop parses it strictly),
    // but a *server* failure never becomes a message carrying provider text.
    expect(failedProvider.status).toBe(400);

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("socket hang up for /home/sumit/secret");
    }));
    const unreachable = await tokenPost(tokenRequest({}));
    expect(unreachable.status).toBe(502);
    const payload = (await unreachable.json()) as { error?: string };
    expect(String(payload.error)).not.toContain("sumit");
    expect(String(payload.error)).not.toContain("socket hang up");
  });

  it("validates every field before contacting the provider", async () => {
    configureProvider();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const invalid: Array<Record<string, string>> = [
      { grant_type: "client_credentials" },
      { code: "" },
      { code_verifier: "tooshort" },
      { code_verifier: "v".repeat(43) + "!" },
      { client_id: "someone-else" },
      { redirect_uri: "https://evil.example/callback" },
    ];
    for (const body of invalid) {
      const response = await tokenPost(tokenRequest(body));
      expect(response.status).toBe(400);
      const payload = (await response.json()) as { code?: string };
      expect(payload.code).toBe("invalid-input");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a form content type and rejects cross-origin callers", async () => {
    configureProvider();
    const wrongType = await tokenPost(
      tokenRequest({}, { "content-type": "application/json" }),
    );
    expect(wrongType.status).toBe(400);

    const crossOrigin = await tokenPost(
      tokenRequest({}, { origin: "https://evil.example" }),
    );
    expect(crossOrigin.status).toBe(403);
  });

  it("is unavailable when unconfigured and rate limited when abused", async () => {
    const unconfigured = await tokenPost(tokenRequest({}));
    expect(unconfigured.status).toBe(503);

    configureProvider();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "tok_abcdefghijklmnop" }), { status: 200 })),
    );
    let limited = false;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const response = await tokenPost(tokenRequest({}));
      if (response.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });

  it("validates the verifier shape exactly as RFC 7636 requires", async () => {
    configureProvider();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const accepted = await exchangeAuthorizationCode(tokenRequest({}));
    expect(accepted.status).toBe(200);
    for (const verifier of ["", "short".repeat(2), "x".repeat(129), "bad*characters".repeat(5)]) {
      await expect(
        exchangeAuthorizationCode(tokenRequest({ code_verifier: verifier })),
      ).rejects.toMatchObject({ code: "invalid-input" });
    }
  });
});

function sessionRequest(cookie?: string): Request {
  return new Request("http://localhost:3000/api/desktop/session", {
    headers: { host: "localhost:3000", ...(cookie ? { cookie } : {}) },
  });
}

const SESSION: Session = {
  sessionId: "sess_desktop",
  tenantId: "tenant-a",
  workspaceId: "workspace-a",
  userId: "user-1",
  role: "operator",
  expiresAt: Date.now() + 60_000,
};

/** Run `body` with the deployment in session-authentication mode. */
async function inSessionMode(body: () => Promise<void>) {
  const previousMode = process.env.TRACEHEALER_AUTH_MODE;
  const previousSecret = process.env.TRACEHEALER_SESSION_SECRET;
  process.env.TRACEHEALER_AUTH_MODE = "session";
  process.env.TRACEHEALER_SESSION_SECRET = "desktop-auth-test-secret";
  try {
    await body();
  } finally {
    if (previousMode === undefined) delete process.env.TRACEHEALER_AUTH_MODE;
    else process.env.TRACEHEALER_AUTH_MODE = previousMode;
    if (previousSecret === undefined) delete process.env.TRACEHEALER_SESSION_SECRET;
    else process.env.TRACEHEALER_SESSION_SECRET = previousSecret;
  }
}

describe("desktop session identity", () => {
  it("reports the identity of the presented session and nothing else", async () => {
    const view = await sessionGet(sessionRequest());
    expect(view.status).toBe(200);
    const payload = (await view.json()) as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(typeof payload.tenantId).toBe("string");
    expect(typeof payload.workspaceId).toBe("string");
    expect(typeof payload.role).toBe("string");
    // No token material is ever part of the identity response.
    const body = JSON.stringify(payload);
    expect(body).not.toContain("session_token");
    expect(body).not.toContain("tracehealer_session");
    expect(body).not.toContain("userId");
  });

  it("requires a session when the deployment is in session mode", async () => {
    await inSessionMode(async () => {
      expect((await sessionGet(sessionRequest())).status).toBe(401);
    });
  });

  it("accepts a signed session cookie and rejects tampering or expiry", async () => {
    await inSessionMode(async () => {
      const valid = issueSessionToken(SESSION, "desktop-auth-test-secret");
      const good = await sessionGet(sessionRequest(`${SESSION_COOKIE_NAME}=${valid}`));
      expect(good.status).toBe(200);
      const payload = (await good.json()) as Record<string, unknown>;
      expect(payload.tenantId).toBe("tenant-a");
      expect(payload.workspaceId).toBe("workspace-a");
      expect(payload.role).toBe("operator");

      // A single flipped character in the signed value must be refused.
      const last = valid.slice(-1);
      const tampered = valid.slice(0, -1) + (last === "A" ? "B" : "A");
      expect((await sessionGet(sessionRequest(`${SESSION_COOKIE_NAME}=${tampered}`))).status).toBe(401);

      // A signed value for another secret is refused.
      const otherSecret = issueSessionToken({ ...SESSION, role: "admin" }, "different-secret");
      expect((await sessionGet(sessionRequest(`${SESSION_COOKIE_NAME}=${otherSecret}`))).status).toBe(401);

      // An expired session is refused even when correctly signed.
      const expired = issueSessionToken({ ...SESSION, expiresAt: Date.now() - 1_000 }, "desktop-auth-test-secret");
      expect((await sessionGet(sessionRequest(`${SESSION_COOKIE_NAME}=${expired}`))).status).toBe(401);
    });
  });
});

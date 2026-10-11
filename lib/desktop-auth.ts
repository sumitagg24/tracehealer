import { TraceHealerError } from "@/lib/errors";
import { assertSameOrigin, clientIp, enforceRateLimit, maxBodyBytes } from "@/lib/http";
import type { Session } from "@/lib/auth";

/**
 * Server-side boundary for the desktop client's sign-in.
 *
 * The desktop never talks to an identity provider directly. It asks this
 * deployment what it supports, is sent to a same-origin authorize endpoint that
 * redirects to the provider, and posts the authorization code plus its PKCE
 * verifier to a same-origin token endpoint that performs the exchange
 * server-side. Two properties follow:
 *
 *  - no client secret ever ships inside the desktop binary, and
 *  - every URL the desktop is willing to send a secret to is on the origin the
 *    user configured, so a compromised renderer cannot redirect a verifier
 *    elsewhere.
 *
 * When the provider is not configured every entry point fails closed with
 * `configured: false` / HTTP 503. There is no synthetic fallback login.
 */

export const DESKTOP_REDIRECT_URI = "tracehealer://auth/callback";
export const AUTHORIZE_PATH = "/api/desktop/auth/authorize";
export const TOKEN_PATH = "/api/desktop/auth/token";

/** Provider environment variables, all server-side only. */
export interface ProviderEnv {
  authorizeUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  scopes?: string;
  providerName?: string;
  clientSecret?: string;
}

function readEnv(env: NodeJS.ProcessEnv): ProviderEnv {
  return {
    authorizeUrl: env.TRACEHEALER_OIDC_AUTHORIZE_URL,
    tokenUrl: env.TRACEHEALER_OIDC_TOKEN_URL,
    clientId: env.TRACEHEALER_OIDC_CLIENT_ID,
    scopes: env.TRACEHEALER_OIDC_SCOPES,
    providerName: env.TRACEHEALER_OIDC_PROVIDER,
    clientSecret: env.TRACEHEALER_OIDC_CLIENT_SECRET,
  };
}

export function providerConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const provider = readEnv(env);
  return Boolean(provider.authorizeUrl && provider.tokenUrl && provider.clientId);
}

/**
 * The deployment's own origin. `APP_URL` wins when set (proxy deployments),
 * otherwise the origin the client actually reached us on is used, which is by
 * definition same-origin with the desktop's configured server.
 */
export function publicOrigin(request: Request, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.APP_URL;
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through to the request origin
    }
  }
  try {
    return new URL(request.url).origin;
  } catch {
    throw new TraceHealerError("unconfigured", "The deployment origin could not be determined");
  }
}

export interface DesktopAuthConfig {
  configured: boolean;
  provider: string;
  clientId: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  scope: string;
  reason: string;
}

const UNCONFIGURED_REASON =
  "This deployment has not configured an external provider (TRACEHEALER_OIDC_AUTHORIZE_URL, TRACEHEALER_OIDC_TOKEN_URL, TRACEHEALER_OIDC_CLIENT_ID).";

/** What the desktop is allowed to know about this deployment's sign-in. */
export function desktopAuthConfig(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): DesktopAuthConfig {
  const provider = readEnv(env);
  if (!providerConfigured(env)) {
    return {
      configured: false,
      provider: "",
      clientId: "",
      authorizeEndpoint: "",
      tokenEndpoint: "",
      scope: "",
      reason: UNCONFIGURED_REASON,
    };
  }
  const origin = publicOrigin(request, env);
  return {
    configured: true,
    // Only the operator-chosen display name is echoed; the provider URLs stay
    // server-side so the desktop cannot be pointed anywhere else.
    provider: provider.providerName?.trim() || "external-oidc",
    clientId: provider.clientId ?? "",
    authorizeEndpoint: `${origin}${AUTHORIZE_PATH}`,
    tokenEndpoint: `${origin}${TOKEN_PATH}`,
    scope: provider.scopes?.trim() || "openid profile email",
    reason: "",
  };
}

/** Query parameters the authorize endpoint is willing to forward. */
export const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "nonce",
  "code_challenge",
  "code_challenge_method",
  "scope",
] as const;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Build the provider authorization URL for a validated request.
 *
 * Only allowlisted parameters are forwarded, `response_type=code` and
 * `code_challenge_method=S256` are required, and the redirect URI must be the
 * registered desktop callback. Because the destination comes from the operator's
 * environment and never from the query string, this is not an open redirect.
 */
export function buildAuthorizeUrl(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const provider = readEnv(env);
  if (!providerConfigured(env)) {
    throw new TraceHealerError("unconfigured", "Desktop sign-in is not configured on this deployment");
  }
  const incoming = new URL(request.url);
  const responseType = incoming.searchParams.get("response_type");
  const codeChallengeMethod = incoming.searchParams.get("code_challenge_method");
  const codeChallenge = incoming.searchParams.get("code_challenge") ?? "";
  const state = incoming.searchParams.get("state") ?? "";
  const nonce = incoming.searchParams.get("nonce") ?? "";
  const redirectUri = incoming.searchParams.get("redirect_uri") ?? "";

  if (responseType !== "code") {
    throw new TraceHealerError("invalid-input", "response_type must be code");
  }
  if (codeChallengeMethod !== "S256") {
    throw new TraceHealerError("invalid-input", "code_challenge_method must be S256");
  }
  if (!BASE64URL.test(codeChallenge) || codeChallenge.length < 43 || codeChallenge.length > 128) {
    throw new TraceHealerError("invalid-input", "code_challenge is not a valid S256 challenge");
  }
  if (!BASE64URL.test(state) || state.length < 16 || state.length > 128) {
    throw new TraceHealerError("invalid-input", "state is missing or malformed");
  }
  if (!BASE64URL.test(nonce) || nonce.length < 16 || nonce.length > 128) {
    throw new TraceHealerError("invalid-input", "nonce is missing or malformed");
  }
  if (redirectUri !== DESKTOP_REDIRECT_URI) {
    throw new TraceHealerError("invalid-input", "redirect_uri must be the registered desktop callback");
  }

  const target = new URL(provider.authorizeUrl as string);
  for (const name of AUTHORIZE_PARAMS) {
    const value = incoming.searchParams.get(name);
    if (value !== null) target.searchParams.set(name, value);
  }
  return target.toString();
}

const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

export interface TokenExchangeResult {
  status: number;
  contentType: string;
  body: string;
}

/**
 * Exchange an authorization code for a token, server-side.
 *
 * The verifier is validated for shape, sent only to the operator-configured
 * token URL, and never logged. The provider's response body is relayed verbatim
 * so the desktop can apply its own strict parsing, but provider bodies are never
 * copied into an error message this server returns.
 */
export async function exchangeAuthorizationCode(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): Promise<TokenExchangeResult> {
  const provider = readEnv(env);
  if (!providerConfigured(env)) {
    throw new TraceHealerError("unconfigured", "Desktop sign-in is not configured on this deployment");
  }
  assertSameOrigin(request);
  enforceRateLimit(`desktop-token:${clientIp(request)}`, 20);

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/x-www-form-urlencoded")) {
    throw new TraceHealerError("invalid-input", "Expected an application/x-www-form-urlencoded request body");
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > maxBodyBytes()) {
    throw new TraceHealerError("payload-too-large", "Request body exceeds the size limit");
  }
  const form = new URLSearchParams(body);

  if (form.get("grant_type") !== "authorization_code") {
    throw new TraceHealerError("invalid-input", "grant_type must be authorization_code");
  }
  const code = form.get("code") ?? "";
  if (!code || code.length > 2048) {
    throw new TraceHealerError("invalid-input", "code is missing or malformed");
  }
  if (!CODE_VERIFIER.test(form.get("code_verifier") ?? "")) {
    throw new TraceHealerError("invalid-input", "code_verifier is missing or malformed");
  }
  if ((form.get("client_id") ?? "") !== provider.clientId) {
    throw new TraceHealerError("invalid-input", "client_id does not match this deployment");
  }
  if ((form.get("redirect_uri") ?? "") !== DESKTOP_REDIRECT_URI) {
    throw new TraceHealerError("invalid-input", "redirect_uri must be the registered desktop callback");
  }

  const outbound = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: form.get("code_verifier") as string,
    client_id: provider.clientId as string,
    redirect_uri: DESKTOP_REDIRECT_URI,
  });
  if (provider.clientSecret) {
    // A confidential deployment keeps its secret here, never in the desktop.
    outbound.set("client_secret", provider.clientSecret);
  }

  let response: Response;
  try {
    response = await fetch(provider.tokenUrl as string, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: outbound.toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // The provider's own failure text is not relayed: only the fact of failure.
    throw new TraceHealerError("delivery-failed", "The identity provider could not be reached");
  }

  const text = (await response.text()).slice(0, 32 * 1024);
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "application/json",
    body: text,
  };
}

/** Identity the desktop learns for the session it presented. */
export function sessionIdentity(session: Session) {
  return {
    tenantId: session.tenantId,
    workspaceId: session.workspaceId,
    role: session.role,
    expiresAt: session.expiresAt,
  };
}

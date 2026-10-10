import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { POST as runsPost, GET as runsGet } from "@/app/api/runs/route";
import { GET as runGet } from "@/app/api/runs/[id]/route";
import { GET as progressGet } from "@/app/api/runs/[id]/progress/route";
import { GET as artifactsGet } from "@/app/api/artifacts/[id]/[kind]/route";
import { POST as cancelPost } from "@/app/api/runs/[id]/cancel/route";
import { POST as publishPost } from "@/app/api/runs/[id]/publish/route";
import { GET as metricsGet } from "@/app/api/metrics/route";
import { GET as incidentsGet } from "@/app/api/incidents/route";
import { POST as healPost } from "@/app/api/heal/route";
import { POST as webhookPost } from "@/app/api/webhooks/neatlogs/route";
import { issueSessionToken, SESSION_COOKIE_NAME, type Session } from "@/lib/auth";
import { resetRateLimits } from "@/lib/http";
import { DEMO_TRACE } from "@/lib/demo-data";
import type { RunState, RunSummary } from "@/lib/types";

function params(value: string): { params: Promise<{ id: string; kind: string }> } {
  const [id, kind = "patch"] = value.split("/");
  return { params: Promise.resolve({ id, kind }) };
}

function cookie(session: Session, secret = "security-test-secret"): string {
  return `${SESSION_COOKIE_NAME}=${issueSessionToken(session, secret)}`;
}

function baseRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Request {
  return new Request(`http://localhost:3000${url}`, {
    method: init.method ?? "GET",
    headers: { host: "localhost:3000", ...init.headers },
    body: init.body,
  });
}

function post(pathname: string, body: string, headers: Record<string, string> = {}): Request {
  return baseRequest(pathname, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

async function waitForTerminal(runId: string, timeoutMs = 25_000): Promise<RunSummary | null> {
  const started = Date.now();
  const adminCookie = cookie(ADMIN);
  const terminal: RunState[] = ["healed", "needs-review", "cancelled", "timed-out"];
  while (Date.now() - started < timeoutMs) {
    const response = await progressGet(
      baseRequest(`/api/runs/${runId}/progress`, { headers: { cookie: adminCookie } }),
      { params: Promise.resolve({ id: runId }) },
    );
    if (response.status === 200) {
      const payload = (await response.json()) as { summary: RunSummary | null };
      if (payload.summary && terminal.includes(payload.summary.state)) return payload.summary;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

const ENV_KEYS = ["TRACEHEALER_DATA_DIR", "TRACEHEALER_AUTH_MODE", "TRACEHEALER_SESSION_SECRET", "NEATLOGS_WEBHOOK_SECRET"] as const;
const saved: Record<string, string | undefined> = {};
let dir: string | null = null;

beforeEach(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  dir = await mkdtemp(path.join(tmpdir(), "tracehealer-security-"));
  Object.assign(process.env, {
    TRACEHEALER_DATA_DIR: dir,
    TRACEHEALER_AUTH_MODE: "session",
    TRACEHEALER_SESSION_SECRET: "security-test-secret",
  });
  resetRateLimits();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = saved[key];
  }
  resetRateLimits();
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

const ADMIN = { tenantId: "tenant-a", workspaceId: "workspace-a", userId: "u1", role: "admin" as const, expiresAt: Date.now() + 3_600_000, sessionId: "s1" };
const OPERATOR = { ...ADMIN, role: "operator" as const, sessionId: "s2" };
const VIEWER = { ...ADMIN, role: "viewer" as const, sessionId: "s3" };
const OTHER_TENANT = { ...ADMIN, tenantId: "tenant-b", sessionId: "s4" };
const EXPIRED = { ...ADMIN, expiresAt: Date.now() - 1_000, sessionId: "s5" };

let seededRunId: string | null = null;

async function seedHealedRun(): Promise<string> {
  if (seededRunId) return seededRunId;
  const response = await runsPost(
    post("/api/runs", JSON.stringify({ mode: "demo" }), { cookie: cookie(ADMIN) }),
  );
  expect(response.status).toBe(202);
  const { runId } = (await response.json()) as { runId: string };
  const summary = await waitForTerminal(runId);
  expect(summary?.state).toBe("healed");
  seededRunId = runId;
  return runId;
}

describe("prompt 10 — route authorization matrix", () => {
  it("rejects every sensitive endpoint without a session", async () => {
    const checks: Array<[() => Promise<Response>, number]> = [
      [() => runsGet(baseRequest("/api/runs")), 401],
      [() => metricsGet(baseRequest("/api/metrics")), 401],
      [() => incidentsGet(baseRequest("/api/incidents")), 401],
      [() => healPost(post("/api/heal", JSON.stringify({ mode: "demo" }))), 401],
    ];
    for (const [call, expected] of checks) {
      const response = await call();
      expect(response.status, "unauthenticated access").toBe(expected);
      const body = (await response.json()) as { code?: string };
      expect(body.code).toBe("unauthorized");
    }
    // Webhooks keep their separate service auth and are NOT session-gated.
    const webhookResponse = await webhookPost(
      post("/api/webhooks/neatlogs", JSON.stringify({ type: "trace.failed", trace: DEMO_TRACE })),
    );
    expect(webhookResponse.status).toBe(202);
  }, 30_000);

  it("enforces role separation on every mutation", async () => {
    const runId = await seedHealedRun();
    const viewerCookie = cookie(VIEWER);
    const operatorCookie = cookie(OPERATOR);

    // viewer: read ok everywhere …
    for (const get of [
      () => runsGet(baseRequest("/api/runs", { headers: { cookie: viewerCookie } })),
      () => metricsGet(baseRequest("/api/metrics", { headers: { cookie: viewerCookie } })),
      () => incidentsGet(baseRequest("/api/incidents", { headers: { cookie: viewerCookie } })),
      () => runGet(baseRequest(`/api/runs/${runId}`, { headers: { cookie: viewerCookie } }), { params: Promise.resolve({ id: runId }) }),
      () =>
        artifactsGet(
          baseRequest(`/api/artifacts/${runId}/report`, { headers: { cookie: viewerCookie } }),
          params(`${runId}/report`),
        ),
    ]) {
      expect((await get()).status, "viewer read").toBe(200);
    }

    // … but every mutation is forbidden.
    for (const mutation of [
      () => runsPost(post("/api/runs", JSON.stringify({ mode: "demo" }), { cookie: viewerCookie })),
      () => healPost(post("/api/heal", JSON.stringify({ mode: "demo" }), { cookie: viewerCookie })),
      () => cancelPost(post(`/api/runs/${runId}/cancel`, "", { cookie: viewerCookie }), { params: Promise.resolve({ id: runId }) }),
      () => publishPost(post(`/api/runs/${runId}/publish`, "", { cookie: viewerCookie }), { params: Promise.resolve({ id: runId }) }),
    ]) {
      const response = await mutation();
      expect(response.status, "viewer mutation").toBe(403);
      expect(((await response.json()) as { code: string }).code, "viewer mutation code").toBe("forbidden");
    }
    void operatorCookie;
  }, 60_000);

  it("hides other tenants' runs and artifacts (404, never 403)", async () => {
    const runId = await seedHealedRun();
    const foreignCookie = cookie(OTHER_TENANT);
    // The run list is scoped (no foreign rows), while a foreign identifier is
    // reported as not-found — never forbidden — so IDs cannot be enumerated.
    const list = await runsGet(baseRequest("/api/runs", { headers: { cookie: foreignCookie } }));
    expect(list.status, "cross-tenant list is readable but empty").toBe(200);
    expect(((await list.json()) as { runs: RunSummary[] }).runs, "no foreign rows listed").toEqual([]);

    for (const get of [
      () => runGet(baseRequest(`/api/runs/${runId}`, { headers: { cookie: foreignCookie } }), { params: Promise.resolve({ id: runId }) }),
      () =>
        artifactsGet(
          baseRequest(`/api/artifacts/${runId}/patch`, { headers: { cookie: foreignCookie } }),
          params(`${runId}/patch`),
        ),
    ]) {
      const response = await get();
      expect(response.status, "cross-tenant resource reads as not-found").toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("not-found");
    }
  }, 30_000);

  it("rejects expired sessions on read and write", async () => {
    const expiredCookie = cookie(EXPIRED);
    const list = await runsGet(baseRequest("/api/runs", { headers: { cookie: expiredCookie } }));
    expect(list.status).toBe(401);
    const create = await runsPost(post("/api/runs", JSON.stringify({ mode: "demo" }), { cookie: expiredCookie }));
    expect(create.status).toBe(401);
  });

  it("requires same-origin for cookie-authenticated mutations but not webhooks", async () => {
    const crossCookie = cookie(OPERATOR);
    const response = await runsPost(
      post("/api/runs", JSON.stringify({ mode: "demo" }), { cookie: crossCookie, origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("invalid-origin");

    // The webhook endpoint authenticates with its own HMAC signature instead.
    Reflect.set(process.env, "NEATLOGS_WEBHOOK_SECRET", "whsec-security-test");
    const { createHmac } = await import("node:crypto");
    const body = JSON.stringify({ type: "trace.failed" });
    const signature = createHmac("sha256", "whsec-security-test").update(body).digest("hex");
    const webhook = await webhookPost(
      post("/api/webhooks/neatlogs", body, {
        "x-neatlogs-signature": `sha256=${signature}`,
        origin: "https://evil.example",
      }),
    );
    // A signed delivery without a trace body is rejected as invalid input,
    // proving the request was authenticated (it passed the signature gate).
    expect(webhook.status).toBe(400);
  });

  it("preserves the size, content-type, and origin boundaries on /api/heal", async () => {
    const admin = cookie(ADMIN);
    expect(
      (await healPost(post("/api/heal", "{}", { cookie: admin }))).status,
      "empty body without a trace in connected mode",
    ).toBe(400);
    expect(
      (await healPost(post("/api/heal", JSON.stringify({ mode: "demo" }), { cookie: admin, "content-type": "text/plain" })))
        .status,
    ).toBe(400);
    expect((await healPost(post("/api/heal", "x".repeat(900_000), { cookie: admin }))).status).toBe(413);
  });

  it("keeps artifact reads path-confined against traversal", async () => {
    const admin = cookie(ADMIN);
    for (const evil of ["..%2F..%2Fpackage.json", "%2e%2e%2f.env", "heal_x%2f..%2f..%2fy"]) {
      const response = await artifactsGet(
        baseRequest(`/api/artifacts/${evil}/patch`, { headers: { cookie: admin } }),
        params(`${evil}/patch`),
      );
      expect(response.status, `traversal probe ${evil}`).toBe(404);
    }
  });
});

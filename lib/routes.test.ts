import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { POST as runsPost } from "@/app/api/runs/route";
import { GET as readyGet } from "@/app/api/ready/route";
import { GET as readinessGet } from "@/app/api/readiness/route";
import { getHealingRun, getRunSummary } from "@/lib/store";
import { resetRateLimits } from "@/lib/http";
import { DEMO_TRACE } from "@/lib/demo-data";
import type { HealResult, RunState, RunSummary } from "@/lib/types";

function request(pathname: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3000${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:3000", ...headers },
    body,
  });
}

async function waitForTerminal(runId: string, timeoutMs = 25_000): Promise<RunSummary | null> {
  const started = Date.now();
  const terminal: RunState[] = ["healed", "needs-review", "cancelled", "timed-out"];
  while (Date.now() - started < timeoutMs) {
    const summary = await getRunSummary(runId);
    if (summary && terminal.includes(summary.state)) return summary;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return getRunSummary(runId);
}

const originalDataDir = process.env.TRACEHEALER_DATA_DIR;

beforeEach(async () => {
  process.env.TRACEHEALER_DATA_DIR = await mkdtemp(path.join(tmpdir(), "tracehealer-routes-"));
  resetRateLimits();
});

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.TRACEHEALER_DATA_DIR;
  else process.env.TRACEHEALER_DATA_DIR = originalDataDir;
  resetRateLimits();
});

describe("prompt 1 — POST /api/runs request contract", () => {
  it("explicit demo starts the deterministic run and returns 202", async () => {
    const response = await runsPost(request("/api/runs", JSON.stringify({ mode: "demo" })));
    expect(response.status).toBe(202);
    const body = (await response.json()) as { ok: boolean; runId: string; state: RunState; deduplicated: boolean };
    expect(body.ok).toBe(true);
    expect(body.runId).toMatch(/^heal_/);
    expect(body.state).toBe("queued");
    expect(body.deduplicated).toBe(false);
    await waitForTerminal(body.runId);
  }, 30_000);

  it("an empty object returns 400 invalid-input and never starts a run", async () => {
    const response = await runsPost(request("/api/runs", JSON.stringify({})));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("invalid-input");
  });

  it("malformed JSON returns 400 invalid-input", async () => {
    const response = await runsPost(request("/api/runs", "not-json"));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("invalid-input");
  });

  it("an invalid trace shape returns 400 invalid-input", async () => {
    const response = await runsPost(request("/api/runs", JSON.stringify({ trace: { bad: true } })));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("invalid-input");
  });

  it("a schema-valid unsupported trace is accepted and ends needs-review with unchanged metrics", async () => {
    const unsupported = {
      ...DEMO_TRACE,
      id: "tr_unsupported_timeout",
      spans: DEMO_TRACE.spans.map((span) =>
        span.id === "sp_parse"
          ? { ...span, error: "Request timeout: upstream tool exceeded its deadline" }
          : span,
      ),
    };
    const response = await runsPost(
      request("/api/runs", JSON.stringify({ mode: "connected", trace: unsupported })),
    );
    expect(response.status).toBe(202);
    const { runId } = (await response.json()) as { runId: string };

    const summary = await waitForTerminal(runId);
    expect(summary?.state).toBe("needs-review");

    const run: HealResult | null = await getHealingRun(runId);
    expect(run, "the persisted run must exist for the unsupported trace").toBeDefined();
    expect(run?.status).toBe("needs-review");
    expect(run?.verification.after).toEqual(run?.verification.before);
    expect(run?.verification.improvements).toEqual({ latencyPercent: 0, tokenPercent: 0, costPercent: 0 });
  }, 30_000);

  it("an incorrect content type returns 400", async () => {
    const response = await runsPost(
      request("/api/runs", JSON.stringify({ mode: "demo" }), { "content-type": "text/plain" }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("invalid-input");
  });

  it("an oversized body returns 413 payload-too-large", async () => {
    const huge = "x".repeat(900_000);
    const response = await runsPost(request("/api/runs", huge));
    expect(response.status).toBe(413);
    expect(((await response.json()) as { code: string }).code).toBe("payload-too-large");
  });

  it("a cross-origin mutation returns 403 invalid-origin", async () => {
    const response = await runsPost(
      request("/api/runs", JSON.stringify({ mode: "demo" }), { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("invalid-origin");
  });
});

describe("prompt 1 — readiness route compatibility", () => {
  it("/api/ready and /api/readiness return equivalent status, payload, and headers", async () => {
    const canonical = await readyGet();
    const alias = await readinessGet();

    expect(canonical.status).toBe(200);
    expect(alias.status).toBe(200);
    expect(canonical.headers.get("cache-control")).toBe(alias.headers.get("cache-control"));

    const canonicalBody = (await canonical.json()) as Record<string, unknown>;
    const aliasBody = (await alias.json()) as Record<string, unknown>;
    expect(Object.keys(canonicalBody).sort()).toEqual(Object.keys(aliasBody).sort());
    expect(aliasBody.status).toBe(canonicalBody.status);
    expect(aliasBody.dataRootWritable).toBe(canonicalBody.dataRootWritable);
    expect(aliasBody.policy).toEqual(canonicalBody.policy);
    expect(aliasBody.integrations).toEqual(canonicalBody.integrations);
  });
});

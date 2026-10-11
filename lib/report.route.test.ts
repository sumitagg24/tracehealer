import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GET as reportGet } from "@/app/api/report/route";
import { POST as runsPost } from "@/app/api/runs/route";
import { GET as progressGet } from "@/app/api/runs/[id]/progress/route";
import { issueSessionToken, SESSION_COOKIE_NAME, type Session } from "@/lib/auth";
import { resetDurableStack } from "@/lib/db";
import { drainInflightRuns } from "@/lib/runs";
import { resetRateLimits } from "@/lib/http";
import {
  notificationEntryFromRun,
  configuredSponsorLinks,
  NOTIFICATION_CHANNELS,
} from "@/lib/notifications";
import {
  buildReportingSummary,
  parseReportingAssumptions,
  sanitizeReportingAssumptions,
} from "@/lib/reporting";
import type { HealResult, RunSummary, RunState } from "@/lib/types";

const SECRET = "report-test-secret";
const ENV_KEYS = [
  "TRACEHEALER_DATA_DIR",
  "TRACEHEALER_STORE",
  "TRACEHEALER_DB_FILE",
  "TRACEHEALER_AUTH_MODE",
  "TRACEHEALER_SESSION_SECRET",
  "TRACEHEALER_SPONSOR_LINKS",
  "TRACEHEALER_REPORTING_ASSUMPTIONS",
] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string | null = null;

beforeEach(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  dataDir = await mkdtemp(path.join(tmpdir(), "tracehealer-report-"));
  Object.assign(process.env, {
    TRACEHEALER_DATA_DIR: dataDir,
    TRACEHEALER_STORE: "sqlite",
    TRACEHEALER_DB_FILE: path.join(dataDir, "tracehealer.db"),
    TRACEHEALER_AUTH_MODE: "session",
    TRACEHEALER_SESSION_SECRET: SECRET,
  });
  delete process.env.TRACEHEALER_SPONSOR_LINKS;
  delete process.env.TRACEHEALER_REPORTING_ASSUMPTIONS;
  await resetDurableStack();
  resetRateLimits();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  // Let in-flight runs finish their store writes before closing sqlite
  // (Windows locks open database files, and a straggler write would throw).
  await drainInflightRuns();
  await resetDurableStack();
  resetRateLimits();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = null;
});

function session(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "s-report",
    userId: "u1",
    tenantId: "tenant-a",
    workspaceId: "workspace-a",
    role: "viewer",
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

function cookie(value: Session): string {
  return `${SESSION_COOKIE_NAME}=${issueSessionToken(value, SECRET)}`;
}

function getRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3000${url}`, {
    headers: { host: "localhost:3000", ...headers },
  });
}

function postRequest(url: string, body: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { host: "localhost:3000", "content-type": "application/json", ...headers },
    body,
  });
}

async function waitForTerminal(runId: string, timeoutMs = 25_000): Promise<RunSummary | null> {
  const started = Date.now();
  const admin = cookie(session({ role: "admin" }));
  const terminal: RunState[] = ["healed", "needs-review", "cancelled", "timed-out"];
  while (Date.now() - started < timeoutMs) {
    const response = await progressGet(
      getRequest(`/api/runs/${runId}/progress`, { cookie: admin }),
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

function healedResult(overrides: Partial<HealResult> = {}): HealResult {
  return {
    id: "heal_abcde",
    incidentId: "inc-1",
    traceId: "trace-1",
    status: "healed",
    mode: "demo",
    diagnosis: {
      category: "schema-drift",
      summary: "Schema drift",
      rootCause: "contract change",
      evidence: [],
      confidence: 0.9,
      file: "src/order-support.mjs",
      line: 12,
      symbol: "getCustomerEmail",
    },
    patch: {
      file: "src/order-support.mjs",
      language: "javascript",
      title: "Handle Order API v3 contact schema",
      rationale: "compat",
      diff: "--- a\n+++ b\n+contact?.primaryEmail\n",
      additions: 1,
      deletions: 0,
    },
    verification: {
      passed: true,
      checks: [
        { name: "Replay", status: "passed", durationMs: 1 },
        { name: "Legacy contract", status: "passed", durationMs: 1 },
      ],
      before: { durationMs: 6842, tokens: 4280, costUsd: 0.0284, errors: 3 },
      after: { durationMs: 820, tokens: 612, costUsd: 0.0041, errors: 0 },
      improvements: { latencyPercent: 88, tokenPercent: 86, costPercent: 86 },
    },
    steps: [
      { id: "capture", label: "Read failure trace", detail: "done", durationMs: 10, status: "complete" },
      { id: "diagnose", label: "Isolate root cause", detail: "done", durationMs: 10, status: "complete" },
      { id: "patch", label: "Generate minimal patch", detail: "done", durationMs: 10, status: "complete" },
      { id: "verify", label: "Replay & verify", detail: "done", durationMs: 10, status: "complete" },
      { id: "proposal", label: "Prepare review", detail: "done", durationMs: 10, status: "complete" },
    ],
    proposal: { number: 1, title: "Fix", branch: "tracehealer/healed-abc", url: null, state: "local" },
    state: "healed",
    events: [],
    correlationId: "c1",
    idempotencyKey: "key-1",
    startedAt: "2026-10-10T00:00:00.000Z",
    completedAt: "2026-10-10T00:00:05.000Z",
    ...overrides,
  };
}

function summary(state: RunSummary["state"] = "healed", status: RunSummary["status"] = "healed"): RunSummary {
  return {
    id: "heal_abcde",
    state,
    status,
    mode: "demo",
    traceId: "trace-1",
    startedAt: "2026-10-10T00:00:00.000Z",
    completedAt: "2026-10-10T00:00:05.000Z",
    hasResult: true,
  };
}

describe("notifications helpers", () => {
  it("builds an in-app notification entry from a healed run", () => {
    const entry = notificationEntryFromRun(healedResult());
    expect(entry).not.toBeNull();
    expect(entry?.channel).toBe("in-app");
    expect(entry?.tone).toBe("ok");
    expect(entry?.title).toBe("Verified a fix");
    expect(entry?.runId).toBe("heal_abcde");
    expect(entry?.traceId).toBe("trace-1");
  });

  it("builds a warning entry from a needs-review summary", () => {
    const entry = notificationEntryFromRun(null, summary("needs-review", "needs-review"));
    expect(entry).not.toBeNull();
    expect(entry?.tone).toBe("warn");
    expect(entry?.title).toBe("Needs review");
  });

  it("builds a bad entry from a delivery-failed summary", () => {
    const entry = notificationEntryFromRun(null, summary("delivery-failed", "needs-review"));
    expect(entry).not.toBeNull();
    expect(entry?.tone).toBe("bad");
    expect(entry?.title).toBe("Delivery failed");
  });

  it("returns null for nothing to report", () => {
    expect(notificationEntryFromRun(null, null)).toBeNull();
  });

  it("keeps sponsor links honest when unconfigured", () => {
    delete process.env.TRACEHEALER_SPONSOR_LINKS;
    expect(configuredSponsorLinks()).toEqual([]);
  });

  it("parses sponsor links from a JSON env value", () => {
    process.env.TRACEHEALER_SPONSOR_LINKS = JSON.stringify([
      { provider: "GitHub Sponsors", label: "Sponsor on GitHub", url: "https://github.com/sponsors/example" },
    ]);
    const links = configuredSponsorLinks();
    expect(links).toHaveLength(1);
    expect(links[0].provider).toBe("GitHub Sponsors");
    expect(links[0].url).toBe("https://github.com/sponsors/example");
  });

  it("ignores invalid sponsor link payloads", () => {
    process.env.TRACEHEALER_SPONSOR_LINKS = JSON.stringify([{ bad: true }]);
    expect(configuredSponsorLinks()).toEqual([]);
  });

  it("keeps NOTIFICATION_CHANNELS stable and truthful", () => {
    expect(NOTIFICATION_CHANNELS).toHaveLength(3);
    expect(NOTIFICATION_CHANNELS.map((c) => c.id)).toContain("in-app");
    expect(NOTIFICATION_CHANNELS.map((c) => c.id)).toContain("slack");
    expect(NOTIFICATION_CHANNELS.map((c) => c.id)).toContain("neatlogs");
  });
});

describe("reporting helpers", () => {
  const metrics = {
    runCount: 10,
    activeRuns: 1,
    byState: { healed: 8, needsReview: 2 },
    healed: 8,
    needsReview: 2,
    successRatePercent: 80,
    deliveryFailureRuns: 1,
    deliveryFailureEvents: 2,
    timeoutCount: 0,
    cancelledCount: 0,
    averageDurationMs: 4200,
  };
  const windowMetrics = {
    runCount: 10,
    activeRuns: 1,
    healed: 8,
    needsReview: 2,
    successRatePercent: 80,
    deliveryFailureRuns: 1,
    timeoutCount: 0,
    cancelledCount: 0,
    averageDurationMs: 4200,
  };

  it("builds a report with no estimate by default", () => {
    const report = buildReportingSummary(metrics, windowMetrics, healedResult().verification);
    expect(report.estimate.enabled).toBe(false);
    expect(report.estimate.minutesSaved).toBeNull();
    expect(report.estimate.costSaved).toBeNull();
    expect(report.estimate.note.toLowerCase()).toContain("no estimated-savings figure shown");
  });

  it("enables an estimate when assumptions are supplied", () => {
    const report = buildReportingSummary(
      metrics,
      windowMetrics,
      healedResult().verification,
      { costPerMinute: 2, manualMinutes: 30, incidentCount: 5 },
    );
    expect(report.estimate.enabled).toBe(true);
    expect(report.estimate.minutesSaved).toBe(150);
    expect(report.estimate.costSaved).toBe(300);
    expect(report.estimate.note.toLowerCase()).toContain("estimate across 5 incidents");
    expect(report.estimate.note.toLowerCase()).toContain("not a measured saving");
  });

  it("keeps estimates honest when incidentCount is omitted", () => {
    const report = buildReportingSummary(
      metrics,
      windowMetrics,
      healedResult().verification,
      { costPerMinute: 2, manualMinutes: 30 },
    );
    // Without incidentCount the formula uses runCount (10), so 30 min/run * 10 = 300 min,
    // and 2 $/min * 30 min * 10 = 600 $.
    expect(report.estimate.enabled).toBe(true);
    expect(report.estimate.minutesSaved).toBe(300);
    expect(report.estimate.costSaved).toBe(600);
    expect(report.estimate.note.toLowerCase()).toContain("estimate across 10 incidents");
  });

  it("ignores invalid assumption values", () => {
    expect(
      buildReportingSummary(metrics, windowMetrics, healedResult().verification, {
        costPerMinute: NaN,
        manualMinutes: Infinity,
        incidentCount: 5,
      }),
    ).toMatchObject({ estimate: { enabled: false } });
  });

  it("parses reporting assumptions from env and drops unknown keys", () => {
    process.env.TRACEHEALER_REPORTING_ASSUMPTIONS = JSON.stringify({
      costPerMinute: 2,
      manualMinutes: 30,
      incidentCount: 5,
      extra: "ignored",
    });
    expect(parseReportingAssumptions()).toEqual({ costPerMinute: 2, manualMinutes: 30, incidentCount: 5 });
  });

  it("returns an empty object for invalid reporting assumptions", () => {
    process.env.TRACEHEALER_REPORTING_ASSUMPTIONS = "{ not json";
    expect(parseReportingAssumptions()).toEqual({});
  });

  it("keeps reporting assumptions honest when only known keys are kept", () => {
    process.env.TRACEHEALER_REPORTING_ASSUMPTIONS = JSON.stringify({
      costPerMinute: "2",
      manualMinutes: 30,
      incidentCount: 5,
      extra: "ignored",
    });
    expect(parseReportingAssumptions()).toEqual({ manualMinutes: 30, incidentCount: 5 });
  });
});

describe("reporting assumption bounds", () => {
  const metrics = {
    runCount: 10,
    activeRuns: 0,
    byState: { healed: 8, needsReview: 2 },
    healed: 8,
    needsReview: 2,
    successRatePercent: 80,
    deliveryFailureRuns: 0,
    deliveryFailureEvents: 0,
    timeoutCount: 0,
    cancelledCount: 0,
    averageDurationMs: 4200,
  };
  const windowMetrics = {
    runCount: 10,
    activeRuns: 0,
    healed: 8,
    needsReview: 2,
    successRatePercent: 80,
    deliveryFailureRuns: 0,
    timeoutCount: 0,
    cancelledCount: 0,
    averageDurationMs: 4200,
  };

  it("drops negative, non-finite, and out-of-bounds values", () => {
    expect(sanitizeReportingAssumptions({ costPerMinute: -5, manualMinutes: 30 })).toEqual({ manualMinutes: 30 });
    expect(sanitizeReportingAssumptions({ costPerMinute: 2, manualMinutes: 1_000_000 })).toEqual({ costPerMinute: 2 });
    expect(sanitizeReportingAssumptions({ costPerMinute: 2, manualMinutes: 30, incidentCount: -1 })).toEqual({
      costPerMinute: 2,
      manualMinutes: 30,
    });
    expect(sanitizeReportingAssumptions({ costPerMinute: 2, manualMinutes: 30, incidentCount: 1.5 })).toEqual({
      costPerMinute: 2,
      manualMinutes: 30,
    });
    expect(sanitizeReportingAssumptions({ costPerMinute: NaN, manualMinutes: Infinity })).toEqual({});
    expect(sanitizeReportingAssumptions({ costPerMinute: 1_000_000, manualMinutes: 30 })).toEqual({ manualMinutes: 30 });
    expect(sanitizeReportingAssumptions("not-an-object")).toEqual({});
  });

  it("never enables an estimate from invalid assumptions", () => {
    const report = buildReportingSummary(metrics, windowMetrics, null, {
      costPerMinute: -10,
      manualMinutes: -10,
    });
    expect(report.estimate.enabled).toBe(false);
    expect(report.estimate.costSaved).toBeNull();
    expect(report.estimate.minutesSaved).toBeNull();
    expect(report.estimate.note.toLowerCase()).toContain("no estimated-savings figure shown");
  });
});

describe("sponsor link safety", () => {
  it("drops javascript, data, file, and plain-http URLs", () => {
    process.env.TRACEHEALER_SPONSOR_LINKS = JSON.stringify([
      { provider: "Evil", label: "Click", url: "javascript:alert(1)" },
      { provider: "Data", label: "Click", url: "data:text/html,<script>alert(1)</script>" },
      { provider: "File", label: "Click", url: "file:///etc/passwd" },
      { provider: "Plain", label: "Click", url: "http://example.com/sponsor" },
      { provider: "Good", label: "Sponsor", url: "https://example.com/sponsor" },
    ]);
    const links = configuredSponsorLinks();
    expect(links).toHaveLength(1);
    expect(links[0].provider).toBe("Good");
    expect(links[0].url.startsWith("https://")).toBe(true);
  });

  it("caps the link count and rejects overlong strings", () => {
    process.env.TRACEHEALER_SPONSOR_LINKS = JSON.stringify(
      Array.from({ length: 10 }, (_, index) => ({
        provider: `P${index}`,
        label: `L${index}`,
        url: `https://example.com/${index}`,
      })),
    );
    expect(configuredSponsorLinks()).toHaveLength(5);

    process.env.TRACEHEALER_SPONSOR_LINKS = JSON.stringify([
      { provider: "x".repeat(65), label: "ok", url: "https://example.com" },
      { provider: "ok", label: "y".repeat(65), url: "https://example.com" },
      { provider: "ok", label: "ok", url: `https://example.com/${"z".repeat(3_000)}` },
    ]);
    expect(configuredSponsorLinks()).toEqual([]);
  });
});

describe("notification terminal states", () => {
  it("maps a cancelled run to a muted entry that does not claim review is needed", () => {
    const entry = notificationEntryFromRun(null, summary("cancelled", "needs-review"));
    expect(entry?.tone).toBe("muted");
    expect(entry?.title).toBe("Run cancelled");
    expect(entry?.detail).toContain("cancelled");
  });

  it("maps a timed-out run to a bad entry", () => {
    const entry = notificationEntryFromRun(null, summary("timed-out", "needs-review"));
    expect(entry?.tone).toBe("bad");
    expect(entry?.title).toBe("Run timed out");
  });

  it("never invents a check count when only a summary is available", () => {
    const entry = notificationEntryFromRun(null, summary("healed", "healed"));
    expect(entry?.tone).toBe("ok");
    expect(entry?.detail).toBe("Verified fix recorded in the run store");
    expect(entry?.detail).not.toContain("checks passed");
  });
});

describe("report route authorization (HTTP)", () => {
  it("rejects an unauthenticated report request with 401", async () => {
    const response = await reportGet(getRequest("/api/report"));
    expect(response.status).toBe(401);
  });

  it("rejects an expired session with 401", async () => {
    const response = await reportGet(
      getRequest("/api/report", { cookie: cookie(session({ expiresAt: Date.now() - 1_000 })) }),
    );
    expect(response.status).toBe(401);
  });

  it("returns a bounded, honest report to a viewer without leaking the session secret", async () => {
    const response = await reportGet(getRequest("/api/report", { cookie: cookie(session()) }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(SECRET);
    const payload = JSON.parse(text) as {
      ok: boolean;
      report: { window: { runCount: number }; estimate: { enabled: boolean; costSaved: number | null } };
      recentNotifications: unknown[];
      sponsorLinks: unknown[];
    };
    expect(payload.ok).toBe(true);
    expect(payload.report.window.runCount).toBe(0);
    expect(payload.report.estimate.enabled).toBe(false);
    expect(payload.report.estimate.costSaved).toBeNull();
    expect(payload.recentNotifications).toEqual([]);
    expect(payload.sponsorLinks).toEqual([]);
  });

  // Seeds a real run through the durable adapter and waits for it to settle, so
  // it gets an explicit budget instead of the 5s default.
  it("does not expose another tenant's metrics, notifications, or run ids", { timeout: 60_000 }, async () => {
    const created = await runsPost(
      postRequest("/api/runs", JSON.stringify({ mode: "demo" }), {
        cookie: cookie(session({ role: "admin" })),
      }),
    );
    expect(created.status).toBe(202);
    const { runId } = (await created.json()) as { runId: string };
    const summary = await waitForTerminal(runId);
    expect(summary?.state).toBe("healed");

    const mine = await reportGet(getRequest("/api/report", { cookie: cookie(session({ role: "admin" })) }));
    expect(mine.status).toBe(200);
    const minePayload = (await mine.json()) as {
      report: { window: { runCount: number } };
      recentNotifications: unknown[];
    };
    expect(minePayload.report.window.runCount).toBeGreaterThan(0);
    expect(minePayload.recentNotifications.length).toBeGreaterThan(0);
    // Bounded recent-run scan: never more than five summaries.
    expect(minePayload.recentNotifications.length).toBeLessThanOrEqual(5);

    const theirs = await reportGet(
      getRequest("/api/report", { cookie: cookie(session({ tenantId: "tenant-b", role: "admin" })) }),
    );
    expect(theirs.status).toBe(200);
    const theirsText = await theirs.text();
    const theirsPayload = JSON.parse(theirsText) as {
      report: { window: { runCount: number } };
      recentNotifications: unknown[];
    };
    expect(theirsPayload.report.window.runCount).toBe(0);
    expect(theirsPayload.recentNotifications).toEqual([]);
    expect(theirsText).not.toContain(runId);
  });
});

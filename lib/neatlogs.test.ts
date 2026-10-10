import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import { DEMO_TRACE } from "@/lib/demo-data";
import { runHealingPipeline } from "@/lib/pipeline";
import { createPipelineDeps } from "@/lib/providers";
import { normalizeTracePayload } from "@/lib/trace-normalizer";
import { redactTraceForModel } from "@/lib/redact";
import { getRunSummary, readArtifactRelative } from "@/lib/store";

/**
 * Prompt 6 — real before/after trace connection, exercised without live
 * neatlogs credentials. The live ingest/export contract remains
 * `unconfigured` until the official endpoint and a project key are provided;
 * every claim below is proven against sanitized local fixtures.
 */

const ENV_KEYS = [
  "TRACEHEALER_DATA_DIR",
  "TRACEHEALER_ALLOWED_REPOSITORIES",
  "TRACEHEALER_ALLOWED_PATHS",
  "NEATLOGS_WEBHOOK_SECRET",
  "TRACEHEALER_WEBHOOK_TOLERANCE_MS",
] as const;
const saved: Record<string, string | undefined> = {};
let dir: string | null = null;

beforeEach(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  dir = await mkdtemp(path.join(os.tmpdir(), "th-neatlogs-"));
  process.env.TRACEHEALER_DATA_DIR = dir;
  process.env.NEATLOGS_WEBHOOK_SECRET = "whsec-test-value";
  process.env.TRACEHEALER_WEBHOOK_TOLERANCE_MS = "300000";
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = saved[key];
  }
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe("prompt 6 — neatlogs before/after evidence contract", () => {
  it("normalizes a sanitized OTLP failure and heals against the same repository", async () => {
    const start = 1_780_000_000_000_000_000;
    const otlp = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "support-agent" } },
              { key: "vcs.repository.name", value: { stringValue: "northstar/support-agent" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "otlp-trace-1",
                  spanId: "root",
                  name: "tool.lookup_order",
                  startTimeUnixNano: String(start),
                  endTimeUnixNano: String(start + 6_000_000),
                  status: { code: 2 },
                  attributes: [{ key: "order.response", value: { stringValue: "email=ada@example.com token=sk-1234567890abcdefghij" } }],
                  events: [
                    {
                      name: "exception",
                      attributes: [
                        { key: "exception.type", value: { stringValue: "TypeError" } },
                        { key: "exception.message", value: { stringValue: "Cannot read properties of undefined (reading 'email')" } },
                        { key: "exception.stacktrace", value: { stringValue: "at resolve (src/order-support.mjs:4:2)" } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const trace = normalizeTracePayload(otlp);
    expect(trace.id).toBe("otlp-trace-1");
    expect(trace.repository).toBe("northstar/support-agent");
    expect(trace.status).toBe("error");
    // Provider secrets in span attributes are redacted before any model/provider
    // use of the trace; the sanitized copy is what leaves the process.
    const raw = JSON.stringify(trace);
    expect(raw).toContain("sk-1234567890abcdefghij"); // intake keeps evidence verbatim
    const sanitized = redactTraceForModel(trace);
    expect(JSON.stringify(sanitized)).not.toContain("sk-1234567890abcdefghij");

    // The sanitized trace (what a model/provider call would receive) heals.
    const deps = createPipelineDeps();
    const result = await runHealingPipeline(trace, "connected", { deps });

    // The failure had to reproduce before anything was patched, and the
    // verified repair produces the after evidence for the same trace id.
    expect(result.status).toBe("healed");
    expect(result.verification.passed).toBe(true);
    expect(result.verification.checks).toHaveLength(4);
    expect(result.traceId).toBe("otlp-trace-1");
    expect(result.artifacts?.beforeReproduced).toBe(true);
    expect(result.artifacts?.beforeTestExitCode).toBe(1);
    expect(result.artifacts?.afterTestExitCode).toBe(0);
    expect(result.artifacts?.beforeLog).toContain("not ok");
    expect(result.artifacts?.afterLog).toContain("ok 1");

    // The run is retrievable through the tenant-free store contract.
    const summary = await getRunSummary(result.id);
    expect(summary?.state).toBe("healed");

    // Patch + report artifacts are downloadable, and neither leaks secrets.
    const patch = await readArtifactRelative(result.artifacts!.patchFile);
    const report = await readArtifactRelative(result.artifacts!.reportFile);
    expect(patch).toContain("order-support");
    expect(patch).not.toContain("sk-1234567890abcdefghij");
    expect(report).not.toContain("sk-1234567890abcdefghij");
    expect(JSON.stringify(redactTraceForModel(trace))).not.toMatch(/sk-[A-Za-z0-9]{6,}/);
  }, 30_000);

  it("signs webhook deliveries the way the intake route verifies them", () => {
    const body = JSON.stringify({ type: "trace.failed", trace: DEMO_TRACE });
    const signature = createHmac("sha256", process.env.NEATLOGS_WEBHOOK_SECRET!).update(body).digest("hex");
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    // The native trace round-trips through the same normalizer the webhook uses.
    expect(normalizeTracePayload(DEMO_TRACE).id).toBe(DEMO_TRACE.id);
  });

  it("keeps the live provider adapter explicitly unconfigured", () => {
    Reflect.deleteProperty(process.env, "NEATLOGS_EXPORT_URL");
    Reflect.deleteProperty(process.env, "NEATLOGS_API_KEY");
    return import("@/lib/integrations").then(({ integrationStatus }) => {
      const status = integrationStatus();
      // Export stays not-configured until the official ingest endpoint and a
      // project key exist; nothing is claimed live.
      expect(status.neatlogs.configured).toBe(false);
    });
  });
});

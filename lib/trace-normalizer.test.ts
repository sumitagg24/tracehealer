import { describe, expect, it } from "vitest";
import { DEMO_TRACE } from "@/lib/demo-data";
import { normalizeTracePayload } from "@/lib/trace-normalizer";

describe("trace payload normalization", () => {
  it("accepts the native trace contract and wrapped events", () => {
    expect(normalizeTracePayload(DEMO_TRACE).id).toBe(DEMO_TRACE.id);
    expect(normalizeTracePayload({ type: "trace.failed", trace: DEMO_TRACE }).spans).toHaveLength(5);
  });

  it("normalizes an OTLP JSON trace", () => {
    const start = 1_780_000_000_000_000_000;
    const trace = normalizeTracePayload({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "support-agent" } },
              { key: "deployment.environment.name", value: { stringValue: "production" } },
              { key: "vcs.repository.name", value: { stringValue: "northstar/support-agent" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "abc123",
                  spanId: "root123",
                  name: "agent.run",
                  startTimeUnixNano: String(start),
                  endTimeUnixNano: String(start + 6_000_000),
                  status: { code: 2 },
                  events: [
                    {
                      name: "exception",
                      attributes: [
                        { key: "exception.type", value: { stringValue: "TypeError" } },
                        { key: "exception.message", value: { stringValue: "Cannot read properties of undefined" } },
                        { key: "exception.stacktrace", value: { stringValue: "at resolve (src/agent.ts:4:2)" } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(trace.id).toBe("abc123");
    expect(trace.repository).toBe("northstar/support-agent");
    expect(trace.status).toBe("error");
    expect(trace.spans[0].error).toContain("TypeError");
    expect(trace.spans[0].durationMs).toBe(6);
  });
});

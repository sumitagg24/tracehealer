import { describe, expect, it } from "vitest";
import { DEMO_TRACE } from "@/lib/demo-data";
import { diagnoseTrace, healTrace } from "@/lib/engine";


describe("TraceHealer engine", () => {
  it("isolates the deepest application failure from a noisy trace", () => {
    const diagnosis = diagnoseTrace(DEMO_TRACE);

    expect(diagnosis.category).toBe("schema-drift");
    expect(diagnosis.file).toBe("src/agents/order-support.ts");
    expect(diagnosis.line).toBe(47);
    expect(diagnosis.symbol).toBe("getCustomerEmail");
    expect(diagnosis.confidence).toBeGreaterThan(0.9);
  });

  it("generates and verifies a minimal compatibility patch", () => {
    const result = healTrace(DEMO_TRACE);

    expect(result.status).toBe("healed");
    expect(result.patch.diff).toContain("contact?.primaryEmail");
    expect(result.verification.passed).toBe(true);
    expect(result.verification.checks).toHaveLength(4);
    expect(result.verification.after.errors).toBe(0);
    expect(result.verification.improvements.latencyPercent).toBeGreaterThan(80);
  });

  it("classifies malformed model output", () => {
    const trace = structuredClone(DEMO_TRACE);
    trace.id = "tr_json";
    trace.spans = trace.spans.map((span) =>
      span.id === "sp_parse"
        ? { ...span, error: "SyntaxError: Unexpected token } in JSON", stack: undefined }
        : span,
    );

    expect(diagnoseTrace(trace).category).toBe("invalid-json");
  });

  it("rejects traces without failed spans", () => {
    const trace = structuredClone(DEMO_TRACE);
    trace.status = "success";
    trace.spans = trace.spans.map((span) => ({ ...span, status: "ok" as const }));

    expect(() => diagnoseTrace(trace)).toThrow(/at least one failed span/);
  });
});

import { describe, expect, it } from "vitest";
import { DEMO_TRACE } from "@/lib/demo-data";
import { diagnoseTrace } from "@/lib/engine";
import { createModelStrategy, deterministicStrategy } from "@/lib/strategies";
import type { RepositoryContext } from "@/lib/context";
import type { PatchInput } from "@/lib/providers";

const diagnosis = diagnoseTrace(DEMO_TRACE);
const context: RepositoryContext = {
  provider: "local-graph",
  filesInspected: ["src/order-support.mjs"],
  relatedTests: ["test/order-support.test.mjs"],
  symbols: ["getCustomerEmail"],
  checkpointId: null,
};
const input: PatchInput = { trace: DEMO_TRACE, diagnosis, context };

describe("deterministic strategy", () => {
  it("supports the reproducible schema-drift failure and produces an allowlisted repair", async () => {
    expect(deterministicStrategy.supports(input)).toBe(true);
    const proposal = await deterministicStrategy.propose(input);
    expect(proposal.file).toBe("src/order-support.mjs");
    expect(proposal.content).toContain("contact?.primaryEmail");
  });

  it("does not claim support for an unrelated failure", () => {
    const other = { ...input, diagnosis: { ...diagnosis, category: "timeout" as const } };
    expect(deterministicStrategy.supports(other)).toBe(false);
  });
});

function modelStrategyReturning(payload: string) {
  return createModelStrategy({ enabled: true, generate: async () => payload });
}

describe("model strategy adversarial cases", () => {
  it("is disabled by policy by default", async () => {
    const strategy = createModelStrategy({ enabled: false, generate: async () => "{}" });
    expect(strategy.supports(input)).toBe(false);
    await expect(strategy.propose(input)).rejects.toThrow(/not enabled/);
  });

  it("rejects malformed structured output", async () => {
    await expect(modelStrategyReturning("not json").propose(input)).rejects.toThrow(/malformed/);
  });

  it("rejects traversal, test deletion, and protected-path targets", async () => {
    const traversal = JSON.stringify({ file: "../outside.mjs", content: "x" });
    await expect(modelStrategyReturning(traversal).propose(input)).rejects.toThrow(/Absolute|traversal/);

    const testDeletion = JSON.stringify({ file: "test/order-support.test.mjs", content: "x" });
    await expect(modelStrategyReturning(testDeletion).propose(input)).rejects.toThrow(/allowlist|Test files/);

    const packageScript = JSON.stringify({ file: "package.json", content: '{"scripts":{"x":"rm -rf /"}}' });
    await expect(modelStrategyReturning(packageScript).propose(input)).rejects.toThrow(/protected/);
  });

  it("accepts a valid allowlisted proposal", async () => {
    const valid = JSON.stringify({
      file: "src/order-support.mjs",
      content: "export const ok = true;\n",
      title: "Fix",
      rationale: "why",
      language: "javascript",
    });
    const proposal = await modelStrategyReturning(valid).propose(input);
    expect(proposal.file).toBe("src/order-support.mjs");
  });

  it("never sends trace secrets to the model", async () => {
    let capturedUser = "";
    const trace = structuredClone(DEMO_TRACE);
    trace.spans[0].input = { apiKey: "sk-super-secret-value-123456" };
    const strategy = createModelStrategy({
      enabled: true,
      generate: async ({ user }) => {
        capturedUser = user;
        return JSON.stringify({ file: "src/order-support.mjs", content: "x", title: "t", rationale: "r", language: "javascript" });
      },
    });
    await strategy.propose({ trace, diagnosis, context });
    expect(capturedUser).not.toContain("sk-super-secret-value-123456");
  });
});

import { describe, expect, it } from "vitest";
import { redactAbsolutePaths, redactLog, redactSecrets, redactTraceForModel } from "@/lib/redact";
import { DEMO_TRACE } from "@/lib/demo-data";

describe("redaction", () => {
  it("removes credentials, tokens, and emails", () => {
    const input = "Authorization: Bearer abcdef1234567890 ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ api_key=supersecret user@example.com";
    const output = redactSecrets(input);
    expect(output).not.toContain("abcdef1234567890");
    expect(output).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(output).not.toContain("supersecret");
    expect(output).not.toContain("user@example.com");
  });

  it("replaces absolute paths but keeps repository-relative identifiers", () => {
    const output = redactAbsolutePaths("at /Users/sumit/projects/x/src/order-support.mjs:9 and src/order-support.mjs");
    expect(output).not.toContain("/Users/sumit");
    expect(output).toContain("src/order-support.mjs");
  });

  it("redacts a known data root explicitly", () => {
    const output = redactLog("wrote C:\\data\\tracehealer\\workspaces\\run\\file", ["C:\\data\\tracehealer"]);
    expect(output).not.toContain("C:\\data\\tracehealer");
  });

  it("produces a bounded, secret-free trace copy for models", () => {
    const trace = structuredClone(DEMO_TRACE);
    trace.spans[0].input = { message: "email me", token: "secret-token-value" };
    const redacted = redactTraceForModel(trace);
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain("secret-token-value");
    expect(redacted.spans).toHaveLength(trace.spans.length);
  });
});

import { describe, expect, it } from "vitest";
import { TraceHealerError } from "@/lib/errors";
import {
  assertAllowedCommand,
  assertAllowedPatch,
  assertAllowedRepository,
  assertSafeRelativePath,
  isInside,
  isProtectedPath,
  loadPolicy,
  matchPathGlob,
} from "@/lib/policy";

describe("security policy", () => {
  it("rejects traversal, absolute, drive-letter, and null-byte paths", () => {
    expect(assertSafeRelativePath("src/order-support.mjs")).toBe("src/order-support.mjs");
    expect(assertSafeRelativePath("src\\order-support.mjs")).toBe("src/order-support.mjs");
    for (const candidate of ["../etc/passwd", "/etc/passwd", "C:/Windows/system32", "src/../../x", "a\u0000b"]) {
      expect(() => assertSafeRelativePath(candidate)).toThrow(TraceHealerError);
    }
  });

  it("enforces the patch allowlist, protected paths, and test-edit ban", () => {
    expect(() => assertAllowedPatch({ file: "src/order-support.mjs", content: "x" })).not.toThrow();
    expect(() => assertAllowedPatch({ file: "src/other.mjs", content: "x" })).toThrow(/allowlist/);
    expect(() => assertAllowedPatch({ file: "package.json", content: "{}" })).toThrow(TraceHealerError);
    expect(() => assertAllowedPatch({ file: "test/order-support.test.mjs", content: "x" })).toThrow(/allowlist|Test files/);
    expect(() => assertAllowedPatch({ file: ".github/workflows/ci.yml", content: "x" })).toThrow(TraceHealerError);
  });

  it("allowlists repositories and command binaries", () => {
    expect(() => assertAllowedRepository("northstar/support-agent")).not.toThrow();
    expect(() => assertAllowedRepository("attacker/repo")).toThrow(TraceHealerError);
    expect(() => assertAllowedCommand("node")).not.toThrow();
    expect(() => assertAllowedCommand("bash")).toThrow(TraceHealerError);
    expect(() => assertAllowedCommand("/usr/bin/git")).not.toThrow();
  });

  it("confines resolved paths inside a root", () => {
    expect(isInside("/data/artifacts", "/data/artifacts/run/change.patch")).toBe(true);
    expect(isInside("/data/artifacts", "/data/artifacts/../secret")).toBe(false);
  });

  it("matches glob patterns including **", () => {
    expect(matchPathGlob("src/**", "src/a/b.ts")).toBe(true);
    expect(matchPathGlob("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(matchPathGlob("*.env", "prod.env")).toBe(true);
    expect(matchPathGlob(".env", ".env")).toBe(true);
    expect(matchPathGlob(".env", "prod.env")).toBe(false);
    expect(isProtectedPath("package-lock.json")).toBe(true);
  });

  it("fails safely on malformed numeric configuration", () => {
    const env = (value: Record<string, string>) => value as unknown as NodeJS.ProcessEnv;
    expect(() => loadPolicy(env({ TRACEHEALER_COMMAND_TIMEOUT_MS: "-5" }))).toThrow(TraceHealerError);
    expect(() => loadPolicy(env({ TRACEHEALER_MAX_OUTPUT_BYTES: "abc" }))).toThrow(TraceHealerError);
    expect(() => loadPolicy(env({ TRACEHEALER_COMMAND_TIMEOUT_MS: "5000" }))).not.toThrow();
  });
});

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_TRACE } from "@/lib/demo-data";
import { executeDemoSandbox } from "@/lib/sandbox";

describe("isolated healing sandbox", () => {
  it("reproduces, patches, verifies and commits the target agent", async () => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), "tracehealer-test-"));
    const result = await executeDemoSandbox(DEMO_TRACE, { dataRoot, workspaceId: "test-run" });

    expect(result.beforeReproduced).toBe(true);
    expect(result.beforeTest.exitCode).not.toBe(0);
    expect(result.afterTest.exitCode).toBe(0);
    expect(result.verification.passed).toBe(true);
    expect(result.verification.checks.every((check) => check.status === "passed")).toBe(true);
    expect(result.patch.diff).toContain("contact?.primaryEmail");
    expect(result.localCommit).toMatch(/^[a-f0-9]{7,}$/);
    expect(await readFile(result.patchFile, "utf8")).toContain("diff --git");
  }, 20_000);
});

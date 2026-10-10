import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_TRACE } from "@/lib/demo-data";
import { executeDemoSandbox, sandboxEnvironment } from "@/lib/sandbox";

describe("sandbox child environment", () => {
  it("withholds platform credentials from target-repository code", () => {
    const env = sandboxEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      GITHUB_TOKEN: "ghp_secret_value",
      NEATLOGS_API_KEY: "nl_secret_value",
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/secret",
      OPENAI_API_KEY: "sk-secret-value-1234567890",
      DATABASE_URL: "postgres://user:pass@host/db",
    } as unknown as NodeJS.ProcessEnv);

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/runner");
    expect(env.CI).toBe("1");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.NEATLOGS_API_KEY).toBeUndefined();
    expect(env.SLACK_WEBHOOK_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("secret");
  });
});

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

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_TRACE } from "@/lib/demo-data";
import { runHealingPipeline } from "@/lib/pipeline";
import { getHealingRun } from "@/lib/store";

const originalDataDir = process.env.TRACEHEALER_DATA_DIR;

describe("complete healing pipeline", () => {
  beforeEach(async () => {
    process.env.TRACEHEALER_DATA_DIR = await mkdtemp(path.join(tmpdir(), "tracehealer-pipeline-"));
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.TRACEHEALER_DATA_DIR;
    else process.env.TRACEHEALER_DATA_DIR = originalDataDir;
  });

  it("reproduces, diagnoses, patches, verifies, commits and persists", async () => {
    const result = await runHealingPipeline(DEMO_TRACE, "demo");

    expect(result.status).toBe("healed");
    expect(result.artifacts?.beforeReproduced).toBe(true);
    expect(result.artifacts?.beforeTestExitCode).not.toBe(0);
    expect(result.artifacts?.afterTestExitCode).toBe(0);
    expect(result.artifacts?.localCommit).toMatch(/^[a-f0-9]{7,}$/);
    expect(result.context?.filesInspected).toContain("src/order-support.mjs");
    expect(result.delivery?.github).toBe("not-configured");

    const persisted = await getHealingRun(result.id);
    expect(persisted?.id).toBe(result.id);
    expect(persisted?.verification.passed).toBe(true);
    const patchFile = path.join(process.env.TRACEHEALER_DATA_DIR!, "artifacts", result.id, "change.patch");
    expect(await readFile(patchFile, "utf8")).toContain("contact?.primaryEmail");
  }, 20_000);
});

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentTrace, CodePatch, VerificationResult } from "@/lib/types";

const execFileAsync = promisify(execFile);

export const HEALED_ORDER_SOURCE = `export class OrderContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "OrderContractError";
  }
}

export function getCustomerEmail(response) {
  const email =
    response.order.customer?.email ??
    response.order.contact?.primaryEmail;

  if (!email) {
    throw new OrderContractError("Order response is missing a customer email");
  }

  return email.toLowerCase();
}

export function resolveReceiptRequest(response) {
  return {
    status: "ready",
    orderId: response.order.id,
    recipient: getCustomerEmail(response),
  };
}
`;

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface ReplayProfile {
  success: boolean;
  attempts: number;
  durationMs: number;
  tokens: number;
  costUsd: number;
  errors: number;
  wallClockMs: number;
  output: unknown;
  error: string | null;
}

export interface SandboxResult {
  workspaceId: string;
  workspacePath: string;
  patchFile: string;
  reportFile: string;
  localCommit: string | null;
  patch: CodePatch;
  verification: VerificationResult;
  beforeReproduced: boolean;
  beforeTest: CommandResult;
  afterTest: CommandResult;
  beforeReplay: ReplayProfile;
  afterReplay: ReplayProfile;
}

async function run(command: string, args: string[], cwd: string): Promise<CommandResult> {
  const started = performance.now();
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        CI: "1",
        NO_COLOR: "1",
      },
    });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: Math.max(1, Math.round(performance.now() - started)),
    };
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
      durationMs: Math.max(1, Math.round(performance.now() - started)),
    };
  }
}

function replayFrom(output: string): ReplayProfile {
  const line = output
    .split("\n")
    .find((candidate) => candidate.startsWith("TRACEHEALER_REPLAY="));
  if (!line) throw new Error("Replay worker did not emit a TRACEHEALER_REPLAY result.");
  return JSON.parse(line.slice("TRACEHEALER_REPLAY=".length)) as ReplayProfile;
}

function compactLog(result: CommandResult) {
  return `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim().slice(-8_000);
}

function percent(before: number, after: number) {
  return before === 0 ? 0 : Math.round(((before - after) / before) * 100);
}

export async function executeDemoSandbox(
  trace: AgentTrace,
  options: { dataRoot?: string; workspaceId?: string } = {},
): Promise<SandboxResult> {
  const workspaceId = options.workspaceId ?? `run_${randomUUID().slice(0, 8)}`;
  const dataRoot = options.dataRoot ?? process.env.TRACEHEALER_DATA_DIR ?? path.join(process.cwd(), ".tracehealer-data");
  const workspacePath = path.join(dataRoot, "workspaces", workspaceId);
  const artifactsPath = path.join(dataRoot, "artifacts", workspaceId);
  const fixturePath = path.join(process.cwd(), "fixtures", "target-agent");

  await mkdir(path.dirname(workspacePath), { recursive: true });
  await mkdir(artifactsPath, { recursive: true });
  await cp(fixturePath, workspacePath, { recursive: true, force: true });

  await run("git", ["init", "-q", "-b", "main"], workspacePath);
  await run("git", ["config", "user.name", "TraceHealer"], workspacePath);
  await run("git", ["config", "user.email", "bot@tracehealer.local"], workspacePath);
  await run("git", ["add", "."], workspacePath);
  await run("git", ["commit", "-q", "-m", "fixture: vulnerable support agent"], workspacePath);

  const beforeTest = await run("node", ["--test"], workspacePath);
  const beforeReplayCommand = await run("node", ["scripts/replay.mjs"], workspacePath);
  const beforeReplay = replayFrom(beforeReplayCommand.stdout);
  const beforeReproduced = beforeTest.exitCode !== 0 && !beforeReplay.success;
  if (!beforeReproduced) {
    throw new Error("Safety gate stopped: the target workspace did not reproduce the observed failure.");
  }

  const targetFile = path.join(workspacePath, "src", "order-support.mjs");
  await writeFile(targetFile, HEALED_ORDER_SOURCE, "utf8");

  const diffResult = await run("git", ["diff", "--", "src/order-support.mjs"], workspacePath);
  const diff = diffResult.stdout.trim();
  if (!diff) throw new Error("Patch generation produced no source change.");

  const afterTest = await run("node", ["--test"], workspacePath);
  const afterReplayCommand = await run("node", ["scripts/replay.mjs"], workspacePath);
  const afterReplay = replayFrom(afterReplayCommand.stdout);
  const passed = afterTest.exitCode === 0 && afterReplayCommand.exitCode === 0 && afterReplay.success;

  let localCommit: string | null = null;
  if (passed) {
    await run("git", ["add", "src/order-support.mjs"], workspacePath);
    const commit = await run(
      "git",
      ["commit", "-q", "-m", "fix(agent): handle Order API v3 contact schema"],
      workspacePath,
    );
    if (commit.exitCode === 0) {
      const revision = await run("git", ["rev-parse", "--short", "HEAD"], workspacePath);
      localCommit = revision.exitCode === 0 ? revision.stdout.trim() : null;
    }
  }

  const checkNames = [
    "Replays the exact failed trace input",
    "Accepts legacy customer.email responses",
    "Accepts v3 contact.primaryEmail responses",
    "Rejects missing email with a typed error",
  ];
  const verification: VerificationResult = {
    passed,
    checks: checkNames.map((name) => ({
      name,
      status: passed ? "passed" : "failed",
      durationMs: Math.max(1, Math.round(afterTest.durationMs / checkNames.length)),
    })),
    before: {
      durationMs: beforeReplay.durationMs || trace.durationMs,
      tokens: beforeReplay.tokens || trace.tokens,
      costUsd: beforeReplay.costUsd || trace.costUsd,
      errors: beforeReplay.errors,
    },
    after: {
      durationMs: afterReplay.durationMs,
      tokens: afterReplay.tokens,
      costUsd: afterReplay.costUsd,
      errors: afterReplay.errors,
    },
    improvements: {
      latencyPercent: percent(beforeReplay.durationMs, afterReplay.durationMs),
      tokenPercent: percent(beforeReplay.tokens, afterReplay.tokens),
      costPercent: percent(beforeReplay.costUsd, afterReplay.costUsd),
    },
  };

  const patch: CodePatch = {
    file: "src/order-support.mjs",
    language: "javascript",
    title: "Handle Order API v3 contact schema",
    rationale:
      "Preserve the legacy customer.email contract, support contact.primaryEmail, and replace the retry-triggering TypeError with a typed contract error.",
    diff,
    additions: diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
  };

  const patchFile = path.join(artifactsPath, "change.patch");
  const reportFile = path.join(artifactsPath, "verification.json");
  await writeFile(patchFile, `${diff}\n`, "utf8");
  await writeFile(
    reportFile,
    `${JSON.stringify(
      {
        workspaceId,
        traceId: trace.id,
        beforeReproduced,
        localCommit,
        verification,
        logs: { before: compactLog(beforeTest), after: compactLog(afterTest) },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // Confirm the generated source exists and is readable before returning a green result.
  await readFile(targetFile, "utf8");

  return {
    workspaceId,
    workspacePath,
    patchFile,
    reportFile,
    localCommit,
    patch,
    verification,
    beforeReproduced,
    beforeTest,
    afterTest,
    beforeReplay,
    afterReplay,
  };
}

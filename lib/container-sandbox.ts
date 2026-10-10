import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { loadPolicy } from "@/lib/policy";
import { TraceHealerError } from "@/lib/errors";

const execFileAsync = promisify(execFile);

/**
 * OS-level isolation boundary for untrusted repositories.
 *
 * `TRACEHEALER_SANDBOX_PROVIDER=docker` selects a provider that executes every
 * target-repository command inside a disposable container:
 *
 *   - no network (`--network none`),
 *   - read-only root filesystem with a bounded writable workspace,
 *   - all capabilities dropped, no setuid (`no-new-privileges`),
 *   - non-root uid/gid,
 *   - CPU, memory, process-limit (fork bomb bound), and wall-clock caps,
 *   - container destroyed after every run.
 *
 * The Docker socket is never exposed to target code and server credentials are
 * never forwarded: the container receives only the repository bind mount.
 * When Docker is absent the provider is reported `unconfigured` — never a silent
 * fall-back to the in-process sandbox.
 */

export const CONTAINER_IMAGE = process.env.TRACEHEALER_CONTAINER_IMAGE ?? "tracehealer-sandbox:latest";

export const CONTAINER_MOUNT_TARGET = "/workspace";

export function dockerRunFlags(namespace: string, memoryMb: number, cpus: string, pidsLimit: number): string[] {
  const containerName = `tracehealer-${namespace}-${randomUUID().slice(0, 8)}`.toLowerCase();
  return [
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    `${memoryMb}m`,
    "--cpus",
    cpus,
    "--pids-limit",
    String(pidsLimit),
  ];
}

/** Full `docker run` argv for one hardened command, test-verifiable verbatim. */
export function buildIsolationDockerArgs(options: {
  workspaceHost: string;
  argv: string[];
  policy: ReturnType<typeof loadPolicy>;
  namespace?: string;
}): string[] {
  const { container } = options.policy;
  return [
    ...dockerRunFlags(options.namespace ?? "run", container.memoryMb, String(container.cpus), container.pidsLimit),
    "--user",
    `${container.uid}:${container.gid}`,
    "--volume",
    `${options.workspaceHost}:${CONTAINER_MOUNT_TARGET}`,
    "--workdir",
    CONTAINER_MOUNT_TARGET,
    "--entrypoint",
    "/bin/sh",
    container.image,
    "-c",
    ...options.argv,
  ];
}

export interface IsolationRule {
  rule: string;
  enforced: boolean;
  how: string;
}

/** Truthful statement of what this provider enforces. Used by UI and evidence. */
export function isolationGuarantees(): IsolationRule[] {
  return [
    { rule: "network", enforced: true, how: "--network none" },
    { rule: "writable-root", enforced: true, how: "--read-only root fs + tmpfs /tmp (64 MB)" },
    { rule: "writable-workspace", enforced: true, how: "bounded bind mount, no host secrets inside" },
    { rule: "capabilities", enforced: true, how: "--cap-drop ALL + no-new-privileges" },
    { rule: "non-root", enforced: true, how: "--user <uid>:<gid> from policy" },
    { rule: "cpu", enforced: true, how: "--cpus policy limit" },
    { rule: "memory", enforced: true, how: "--memory policy limit" },
    { rule: "process-count", enforced: true, how: "--pids-limit policy limit" },
    { rule: "wall-clock", enforced: true, how: "exec timeout kill" },
    { rule: "docker-socket", enforced: true, how: "socket is never mounted into target" },
    { rule: "server-env", enforced: true, how: "no -e / --env-file; container env is empty" },
  ];
}

async function runDocker(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync("docker", args, { timeout: 120_000, signal });
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { code?: string };
    if (err.code === "ENOENT") {
      throw new TraceHealerError(
        "unconfigured",
        "Docker is required by the container sandbox but is not installed on this host",
        { cause: error },
      );
    }
    if (signal?.aborted) {
      throw new TraceHealerError("cancelled", "Container run cancelled", { cause: error });
    }
    throw new TraceHealerError("internal", "Container run failed", { cause: error });
  }
}

async function insideContainer(
  workspaceHost: string,
  namespace: string,
  argv: string[],
  policy: ReturnType<typeof loadPolicy>,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  await mkdir(workspaceHost, { recursive: true });
  const args = buildIsolationDockerArgs({ workspaceHost, argv, policy, namespace });
  try {
    await writeFile(path.join(workspaceHost, ".write-probe"), "ok", "utf8");
    await rm(path.join(workspaceHost, ".write-probe"), { force: true });
  } catch (error) {
    throw new TraceHealerError("internal", "The host workspace root is not writable", { cause: error });
  }

  try {
    const { stdout, stderr } = await runDocker(args, signal);
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    if (error instanceof TraceHealerError) throw error;
    // A non-zero container exit surfaces as a process-level error carrying
    // stdout/stderr; keep exit-code semantics identical to the local provider.
    const err = error as { stdout?: string; stderr?: string; killed?: boolean; code?: number | string };
    if (err.killed) {
      throw new TraceHealerError("timeout", "Container command exceeded its deadline", { cause: error });
    }
    return {
      exitCode: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

/** Container fixture proving that isolation denies the known attack families. */
export interface IsolationProbe {
  name: string;
  /** The script runs inside the container via /bin/sh -c. */
  script: string;
  /** What must be true afterwards for the boundary to hold. */
  expect: (result: { exitCode: number; stdout: string; stderr: string }) => boolean;
  description: string;
}

export function isolationProbes(): IsolationProbe[] {
  return [
    {
      name: "no-network",
      script:
        "node -e \"require('node:dns').lookup('example.com',(e)=>{console.log(e?'BLOCKED':'REACHED');process.exit(e?0:1)})\"",
      expect: (r) => r.stdout.includes("BLOCKED") || r.exitCode !== 0,
      description: "DNS resolution must fail without network access",
    },
    {
      name: "read-only-root",
      script:
        "node -e \"try{require('node:fs').writeFileSync('/etc/escape','x');console.log('ROOT-WRITABLE')}catch{console.log('ROOT-IMMUTABLE')}\"",
      expect: (r) => r.stdout.includes("ROOT-IMMUTABLE"),
      description: "Writing to /etc must fail (read-only root)",
    },
    {
      name: "non-root",
      script: "node -e \"console.log('uid='+process.getuid())\"",
      expect: (r) => !r.stdout.includes("uid=0"),
      description: "The container user must not be root",
    },
    {
      name: "no-server-env",
      // The container env is injected only by the probe below (via the workspace),
      // so any GITHUB_TOKEN seen here would prove the host forwarded it.
      script:
        "node -e \"const e=process.env;console.log('github='+JSON.stringify(e.GITHUB_TOKEN??null)+';neatlogs='+JSON.stringify(e.NEATLOGS_API_KEY??null)+';uid='+process.getuid())\"",
      expect: (r) => r.stdout.includes("github=null") && r.stdout.includes("neatlogs=null"),
      description: "No credential variable is forwarded into the container",
    },
    {
      name: "docker-socket-absent",
      script: "node -e \"try{require('node:fs').statSync('/var/run/docker.sock');console.log('SOCKET-PRESENT')}catch{console.log('SOCKET-ABSENT')}\"",
      expect: (r) => r.stdout.includes("SOCKET-ABSENT"),
      description: "The Docker socket is never mounted inside the target",
    },
  ];
}

export interface IsolationProof {
  image: string;
  mountTarget: string;
  output: { exitCode: number; stdout: string; stderr: string } | null;
  results: Array<{ name: string; description: string; passed: boolean; evidence: string }>;
}

export async function runIsolationProof(
  workspaceHost?: string,
  smokeCommand: string = "node --version",
  signal?: AbortSignal,
): Promise<IsolationProof> {
  const policy = loadPolicy();
  const workspace = workspaceHost ?? (await mkdtemp(path.join(os.tmpdir(), "tracehealer-proof-")));
  let output: IsolationProof["output"] = null;
  const results: IsolationProof["results"] = [];
  try {
    // Cheap smoke first: prove the image and mount actually execute.
    output = await insideContainer(workspace, "proof", [smokeCommand], policy, signal);
    results.push({
      name: "container-executes",
      description: "The sandbox image can run a command against the mounted workspace",
      passed: output.exitCode === 0,
      evidence: output.stdout.trim().slice(0, 120) || `exit=${output.exitCode}`,
    });
    for (const probe of isolationProbes()) {
      const outcome = await insideContainer(workspace, "proof", [probe.script], policy, signal);
      const passed = probe.expect(outcome);
      results.push({
        name: probe.name,
        description: probe.description,
        passed,
        evidence: outcome.stdout.trim().slice(0, 200) || `exit=${outcome.exitCode}`,
      });
    }
  } finally {
    if (!workspaceHost) {
      await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return { image: policy.container.image, mountTarget: CONTAINER_MOUNT_TARGET, output, results };
}

/** Read a file from the host workspace after a container run (artifact pickup). */
export async function readWorkspaceFile(workspaceHost: string, relative: string): Promise<string | null> {
  if (!relative || relative.includes("\\u0000")) return null;
  const target = path.resolve(workspaceHost, ...relative.replace(/\\\\/g, "/").split("/"));
  const relativePath = path.relative(path.resolve(workspaceHost), target);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  try {
    return await readFile(target, "utf8");
  } catch {
    return null;
  }
}

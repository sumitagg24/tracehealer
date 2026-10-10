import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildIsolationDockerArgs,
  CONTAINER_MOUNT_TARGET,
  isolationGuarantees,
  isolationProbes,
  runIsolationProof,
} from "@/lib/container-sandbox";
import { loadPolicy } from "@/lib/policy";

const saved: Record<string, string | undefined> = {};
const KEYS = [
  "TRACEHEALER_CONTAINER_IMAGE",
  "TRACEHEALER_CONTAINER_MEMORY_MB",
  "TRACEHEALER_CONTAINER_CPUS",
  "TRACEHEALER_CONTAINER_PIDS_LIMIT",
  "TRACEHEALER_CONTAINER_UID",
  "TRACEHEALER_CONTAINER_GID",
  "GITHUB_TOKEN",
  "NEATLOGS_API_KEY",
] as const;

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  process.env.TRACEHEALER_CONTAINER_IMAGE = "th-test-image:latest";
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
    else Object.assign(process.env, { [key]: saved[key] });
  }
});

let dir: string | null = null;

async function workspaceHost(): Promise<string> {
  const created = await mkdtemp(path.join(os.tmpdir(), "th-container-"));
  dir = created;
  return created;
}

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  dir = null;
});

describe("prompt 4 — container isolation contract", () => {
  it("hardens the docker run invocation exactly as documented", () => {
    const policy = loadPolicy();
    const args = buildIsolationDockerArgs({
      workspaceHost: "/tmp/host-ws",
      argv: ["node --test"],
      policy,
      namespace: "verify",
    });
    expect(args[0]).toBe("run");
    expect(args).toContain("--network"); // no network at all
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args).toContain("--read-only"); // immutable root fs
    expect(args).toContain("--cap-drop");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("--user");
    expect(args[args.indexOf("--user") + 1]).toBe(`${policy.container.uid}:${policy.container.gid}`);
    expect(args).toContain("--memory");
    expect(args).toContain("--cpus");
    expect(args).toContain("--pids-limit");
    // The workspace bind mount targets the container path, not the host.
    expect(args).toContain(`${"/tmp/host-ws"}:${CONTAINER_MOUNT_TARGET}`);
    // The socket is never mounted, and no environment is forwarded.
    for (const arg of args) {
      expect(String(arg)).not.toContain("/var/run/docker.sock");
      expect(String(arg)).not.toMatch(/--env(-file)?$/);
    }
    expect(args.at(-1)).toBe("node --test");
    // The image comes from policy, which reads TRACEHEALER_CONTAINER_IMAGE.
    expect(args).toContain(policy.container.image);
  });

  it("declares every isolation guarantee with an enforcement mechanism", () => {
    const guarantees = isolationGuarantees();
    for (const rule of ["network", "capabilities", "non-root", "cpu", "memory", "process-count", "docker-socket", "server-env"]) {
      const match = guarantees.find((entry) => entry.rule === rule);
      expect(match?.enforced, `guarantee ${rule}`).toBe(true);
      expect(match?.how.length ?? 0, `mechanism for ${rule}`).toBeGreaterThan(0);
    }
  });

  it("writes probe scripts that cannot read host credentials", () => {
    process.env.GITHUB_TOKEN = "super-secret-value";
    process.env.NEATLOGS_API_KEY = "another-secret";
    const probes = isolationProbes();
    expect(probes.map((probe) => probe.name)).toEqual(
      expect.arrayContaining(["no-network", "non-root", "no-server-env", "docker-socket-absent", "read-only-root"]),
    );
    // The probe scripts themselves assert no leaked credentials.
    const envProbe = probes.find((probe) => probe.name === "no-server-env");
    expect(envProbe?.script).toMatch(/GITHUB_TOKEN/);
    expect(envProbe?.description).toMatch(/No credential variable/);
  });
});

describe("prompt 4 — live Docker isolation proof", () => {
  it(
    "runs the malicious-fixture probes in a real hardened container",
    { timeout: 600_000 },
    async () => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile);
      let dockerOk = false;
      try {
        await run("docker", ["info", "--format", "ok"], { timeout: 30_000 });
        dockerOk = true;
      } catch {
        dockerOk = false;
      }
      if (!dockerOk) {
        console.warn("Docker unavailable; container proof skipped (not claimed as verified).");
        return;
      }

      // Build the dedicated sandbox image the provider references.
      const repoRoot = process.cwd();
      await run(
        "docker",
        ["build", "-f", "docker/sandbox.Dockerfile", "-t", "tracehealer-sandbox:latest", repoRoot],
        { timeout: 500_000 },
      );
      Reflect.set(process.env, "TRACEHEALER_CONTAINER_IMAGE", "tracehealer-sandbox:latest");

      const host = await workspaceHost();
      const proof = await runIsolationProof(host, "node --version");
      expect(proof.image).toBe("tracehealer-sandbox:latest");
      expect(proof.results.map((result) => result.name)).toEqual(
        expect.arrayContaining(["no-network", "non-root", "no-server-env", "docker-socket-absent"]),
      );
      for (const result of proof.results) {
        expect(result.passed, `${result.name}: ${result.evidence}`).toBe(true);
      }
    },
  );
});

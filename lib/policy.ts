import path from "node:path";
import { TraceHealerError } from "@/lib/errors";
import type { PatchProposal } from "@/lib/providers";

export interface TraceHealerPolicy {
  allowedRepositories: string[];
  allowedPatchPaths: string[];
  allowedCommandBinaries: string[];
  protectedPaths: string[];
  allowedExtensions: string[];
  commandTimeoutMs: number;
  maxOutputBytes: number;
  maxDiffBytes: number;
  allowTestEdits: boolean;
  allowModelPatches: boolean;
}

const DEFAULT_PROTECTED = [
  ".github/**",
  ".git/**",
  "package.json",
  "package-lock.json",
  "compose.yaml",
  "Dockerfile",
  ".env",
  ".env.*",
  "**/*.env",
  "next.config.ts",
];

function splitList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new TraceHealerError("invalid-input", `Malformed configuration: ${name} must be a positive integer`);
  }
  return parsed;
}

function boolValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "true";
}

export function loadPolicy(env: NodeJS.ProcessEnv = process.env): TraceHealerPolicy {
  return {
    allowedRepositories: splitList(env.TRACEHEALER_ALLOWED_REPOSITORIES, ["northstar/support-agent"]),
    allowedPatchPaths: splitList(env.TRACEHEALER_ALLOWED_PATHS, ["src/order-support.mjs"]),
    allowedCommandBinaries: splitList(env.TRACEHEALER_ALLOWED_BINARIES, ["node", "git", "npm"]),
    protectedPaths: splitList(env.TRACEHEALER_PROTECTED_PATHS, DEFAULT_PROTECTED),
    allowedExtensions: splitList(env.TRACEHEALER_ALLOWED_EXTENSIONS, [".mjs", ".js", ".ts", ".tsx", ".json"]),
    commandTimeoutMs: positiveInt(env.TRACEHEALER_COMMAND_TIMEOUT_MS, 20_000, "TRACEHEALER_COMMAND_TIMEOUT_MS"),
    maxOutputBytes: positiveInt(env.TRACEHEALER_MAX_OUTPUT_BYTES, 1024 * 1024, "TRACEHEALER_MAX_OUTPUT_BYTES"),
    maxDiffBytes: positiveInt(env.TRACEHEALER_MAX_DIFF_BYTES, 200_000, "TRACEHEALER_MAX_DIFF_BYTES"),
    allowTestEdits: boolValue(env.TRACEHEALER_ALLOW_TEST_EDITS, false),
    allowModelPatches: boolValue(env.TRACEHEALER_ALLOW_MODEL_PATCHES, false),
  };
}

/** Glob-lite matcher supporting `**` and `*` segments used by the allowlists. */
export function matchPathGlob(pattern: string, candidate: string): boolean {
  const normalized = candidate.replaceAll("\\", "/");
  const escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`).test(normalized);
}

export function isProtectedPath(candidate: string, policy: TraceHealerPolicy = loadPolicy()): boolean {
  return policy.protectedPaths.some((pattern) => matchPathGlob(pattern, candidate));
}

/**
 * Reject anything that is not a plain repository-relative path. This defends
 * against traversal, absolute paths, Windows drive letters, UNC paths, and
 * null-byte injection before the value can reach the filesystem.
 */
export function assertSafeRelativePath(candidate: string): string {
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new TraceHealerError("policy-rejected", "Patch target must be a non-empty path");
  }
  if (candidate.includes("\u0000")) {
    throw new TraceHealerError("policy-rejected", "Patch target contains an illegal character");
  }
  const normalized = candidate.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith("//")) {
    throw new TraceHealerError("policy-rejected", "Absolute paths are not allowed");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    throw new TraceHealerError("policy-rejected", "Path traversal is not allowed");
  }
  return normalized;
}

/** True only when `target` resolves inside `root` (defeats `..` and symlink escapes). */
export function isInside(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertAllowedRepository(repository: string, policy: TraceHealerPolicy = loadPolicy()): void {
  const allowed = policy.allowedRepositories.some(
    (entry) => entry === repository || matchPathGlob(entry, repository),
  );
  if (!allowed) {
    throw new TraceHealerError("policy-rejected", "Repository is not in the administrator allowlist");
  }
}

export function assertAllowedCommand(binary: string, policy: TraceHealerPolicy = loadPolicy()): void {
  const base = path.basename(binary);
  if (!policy.allowedCommandBinaries.includes(base)) {
    throw new TraceHealerError("policy-rejected", "Command is not in the administrator allowlist");
  }
}

/** Validate a proposed patch before it can be written or executed. */
export function assertAllowedPatch(
  proposal: Pick<PatchProposal, "file" | "content">,
  policy: TraceHealerPolicy = loadPolicy(),
): void {
  const file = assertSafeRelativePath(proposal.file);
  if (isProtectedPath(file, policy)) {
    throw new TraceHealerError("policy-rejected", "Patch targets a protected path");
  }
  const looksLikeTest = /(^|\/)(tests?|__tests__)\//.test(file) || /\.(test|spec)\.[a-z]+$/.test(file);
  if (looksLikeTest && !policy.allowTestEdits) {
    throw new TraceHealerError("policy-rejected", "Test files cannot be modified by policy");
  }
  const allowed = policy.allowedPatchPaths.some((pattern) => matchPathGlob(pattern, file));
  if (!allowed) {
    throw new TraceHealerError("policy-rejected", "Patch path is not in the administrator allowlist");
  }
  const extension = path.extname(file);
  if (!policy.allowedExtensions.includes(extension)) {
    throw new TraceHealerError("policy-rejected", "Patch file extension is not allowed");
  }
  if (Buffer.byteLength(proposal.content, "utf8") > policy.maxDiffBytes) {
    throw new TraceHealerError("policy-rejected", "Proposed patch exceeds the maximum size");
  }
}

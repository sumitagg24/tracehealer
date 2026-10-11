import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { canCancel, isTerminal } from "@/lib/run-state";
import type { AuditEvent, HealResult, Incident, RunState, RunSummary } from "@/lib/types";

function root() {
  return process.env.TRACEHEALER_DATA_DIR ?? path.join(process.cwd(), ".tracehealer-data");
}

/** Only a conservative identifier shape may ever reach the filesystem. */
export function isSafeId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id);
}

/** Serialize writes per path so concurrent updates cannot race a rename. */
const writeChains = new Map<string, Promise<unknown>>();

function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const previous = writeChains.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  writeChains.set(
    key,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** On Windows, renaming onto an open handle can transiently fail with EPERM/EBUSY. */
async function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === 4 || (code !== "EPERM" && code !== "EBUSY")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15 * (attempt + 1)));
    }
  }
}

/** Assumes the caller already holds the file lock for `file`. */
async function writeJsonUnlocked(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await renameWithRetry(temporary, file);
}

async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await withFileLock(file, () => writeJsonUnlocked(file, value));
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function saveHealingRun(result: HealResult) {
  await atomicJson(path.join(root(), "runs", `${result.id}.json`), result);
}

export async function getHealingRun(id: string): Promise<HealResult | null> {
  if (!isSafeId(id)) return null;
  return readJson<HealResult>(path.join(root(), "runs", `${id}.json`));
}

export async function listHealingRuns(limit = 25): Promise<HealResult[]> {
  const directory = path.join(root(), "runs");
  try {
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
    const values = await Promise.all(
      files.map((file) => readJson<HealResult>(path.join(directory, file))),
    );
    return values
      .filter((value): value is HealResult => value !== null)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, Math.max(1, Math.min(limit, 100)));
  } catch {
    return [];
  }
}

/**
 * Persist a lightweight, secret-free projection for in-progress and finished runs.
 *
 * This is the single enforcement point for run finality: once a summary reached a
 * terminal state, a later write may only restate that same state. Without this a
 * cancellation could be overwritten by a verification step that was already in
 * flight.
 */
export async function saveRunSummary(summary: RunSummary) {
  if (!isSafeId(summary.id)) throw new Error("Unsafe run id");
  const file = path.join(root(), "summaries", `${summary.id}.json`);
  // The read-check-write runs under the per-file lock, so two concurrent writers
  // cannot both observe a pre-terminal state and then overwrite each other.
  await withFileLock(file, async () => {
    const existing = await readJson<RunSummary>(file);
    if (existing && existing.state !== summary.state && isTerminal(existing.state)) {
      return;
    }
    await writeJsonUnlocked(file, summary);
  });
}

export async function getRunSummary(id: string): Promise<RunSummary | null> {
  if (!isSafeId(id)) return null;
  return readJson<RunSummary>(path.join(root(), "summaries", `${id}.json`));
}

export async function listRunSummaries(limit = 25): Promise<RunSummary[]> {
  const directory = path.join(root(), "summaries");
  try {
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
    const values = await Promise.all(
      files.map((file) => readJson<RunSummary>(path.join(directory, file))),
    );
    return values
      .filter((value): value is RunSummary => value !== null)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, Math.max(1, Math.min(limit, 100)));
  } catch {
    return [];
  }
}

/**
 * Record an authoritative human cancellation.
 *
 * `saveRunSummary` refuses any write that contradicts a terminal state, which is
 * what protects a finalized run. Cancellation needs exactly one documented
 * exception: a pipeline that observes the abort can write the terminal
 * `needs-review` verdict *before* the coordinator records the cancel, so the
 * coordinator must still be able to replace that non-verified verdict. Verified
 * and already-decided runs stay untouched (see `canCancel`).
 */
export async function cancelRunSummary(
  id: string,
  completedAt: string,
): Promise<RunSummary | null> {
  if (!isSafeId(id)) return null;
  const file = path.join(root(), "summaries", `${id}.json`);
  return withFileLock(file, async () => {
    const existing = await readJson<RunSummary>(file);
    if (!existing) return null;
    // Repeating a cancellation is a no-op so the original timestamp is kept.
    if (existing.state === "cancelled") return existing;
    if (!canCancel(existing.state)) return existing;
    const cancelled: RunSummary = { ...existing, state: "cancelled", completedAt };
    await writeJsonUnlocked(file, cancelled);
    return cancelled;
  });
}

export async function updateRunState(id: string, state: RunState, completedAt: string | null = null) {
  const summary = await getRunSummary(id);
  if (!summary) return null;
  // A settled terminal run is final: a late progress write (for example a
  // verification step arriving after a cancel) must never resurrect it.
  if (summary.state !== state && isTerminal(summary.state)) return summary;
  const updated: RunSummary = { ...summary, state, completedAt: completedAt ?? summary.completedAt };
  await saveRunSummary(updated);
  return updated;
}

/** Append-only audit trail. One JSON line per event, never rewritten. */
export async function appendRunEvent(runId: string, event: AuditEvent): Promise<void> {
  if (!isSafeId(runId)) throw new Error("Unsafe run id");
  const file = path.join(root(), "events", `${runId}.jsonl`);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
}

export async function readRunEvents(runId: string): Promise<AuditEvent[]> {
  if (!isSafeId(runId)) return [];
  try {
    const raw = await readFile(path.join(root(), "events", `${runId}.jsonl`), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEvent)
      .sort((a, b) => a.seq - b.seq);
  } catch {
    return [];
  }
}

/**
 * Cross-restart idempotency lookup. Scans persisted summaries and returns the
 * most recent run created for a key so a duplicate webhook or heal request can
 * reuse the existing run instead of mutating the workspace twice.
 */
export async function findRunByIdempotencyKey(key: string): Promise<RunSummary | null> {
  if (!key) return null;
  const summaries = await listRunSummaries(100);
  return summaries.find((summary) => summary.idempotencyKey === key) ?? null;
}

export async function saveIncident(incident: Incident) {
  await atomicJson(path.join(root(), "incidents", `${incident.id}.json`), incident);
}

/** Read a data-root-relative artifact file, refusing anything outside the root. */
export async function readArtifactRelative(relative: string): Promise<string | null> {
  if (typeof relative !== "string" || relative.length === 0 || relative.includes("\u0000")) return null;
  const normalized = relative.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) return null;
  const dataRoot = path.resolve(/* turbopackIgnore: true */ root());
  const target = path.resolve(/* turbopackIgnore: true */ path.join(dataRoot, ...normalized.split("/")));
  const rel = path.relative(dataRoot, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  try {
    return await readFile(target, "utf8");
  } catch {
    return null;
  }
}

const ARTIFACT_FILES = { patch: "change.patch", report: "verification.json" } as const;
export type ArtifactKind = keyof typeof ARTIFACT_FILES;

export interface Artifact {
  content: string;
  contentType: string;
  filename: string;
}

/**
 * Read a generated artifact. The run id and kind are validated and the resolved
 * path is confirmed to stay inside the artifacts root before any read, so
 * traversal and download of unrelated files are impossible.
 */
export async function readArtifact(runId: string, kind: ArtifactKind): Promise<Artifact | null> {
  if (!isSafeId(runId)) return null;
  const filename = ARTIFACT_FILES[kind];
  if (!filename) return null;
  const artifactsRoot = path.resolve(path.join(root(), "artifacts"));
  const target = path.resolve(path.join(artifactsRoot, runId, filename));
  const relative = path.relative(artifactsRoot, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    const content = await readFile(target, "utf8");
    return {
      content,
      contentType: kind === "patch" ? "text/x-diff; charset=utf-8" : "application/json; charset=utf-8",
      filename: `${runId}.${kind === "patch" ? "patch" : "json"}`,
    };
  } catch {
    return null;
  }
}

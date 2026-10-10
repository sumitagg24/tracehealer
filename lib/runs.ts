import { randomUUID } from "node:crypto";
import { TraceHealerError } from "@/lib/errors";
import { runHealingPipeline } from "@/lib/pipeline";
import { createPipelineDeps, type PipelineDeps } from "@/lib/providers";
import { isTerminal, SETTLED_STATES } from "@/lib/run-state";
import { getHealingRun, getRunSummary, readRunEvents, saveHealingRun, saveRunSummary } from "@/lib/store";
import type { AgentTrace, AuditEvent, HealResult, RunState, RunSummary } from "@/lib/types";

interface Inflight {
  cancelled: boolean;
  controller: AbortController;
  promise: Promise<HealResult | null>;
}

/** Process-local coordination state. Durable truth lives in the run store. */
const inflight = new Map<string, Inflight>();

export interface StartRunInput {
  trace: AgentTrace;
  mode: "demo" | "connected";
  idempotencyKey?: string;
  deps?: PipelineDeps;
  timeoutMs?: number;
}

export interface StartedRun {
  runId: string;
  state: RunState;
  deduplicated: boolean;
}

export interface RunProgress {
  summary: RunSummary | null;
  events: AuditEvent[];
  result: HealResult | null;
}

function depsOf(input: StartRunInput): PipelineDeps {
  return input.deps ?? createPipelineDeps();
}

/**
 * Create (or dedupe) a healing run and begin executing it in the background.
 * Returns immediately so the caller can stream real server progress by polling.
 */
export async function startHealingRun(input: StartRunInput): Promise<StartedRun> {
  const deps = depsOf(input);

  if (input.idempotencyKey) {
    const existing = await deps.runStore.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return { runId: existing.id, state: existing.state, deduplicated: true };
    }
  }

  const runId = `heal_${randomUUID().slice(0, 8)}`;
  const correlationId = randomUUID();
  const startedAt = new Date().toISOString();

  const initial: RunSummary = {
    id: runId,
    state: "queued",
    status: "needs-review",
    mode: input.mode,
    traceId: input.trace.id,
    startedAt,
    completedAt: null,
    hasResult: false,
    idempotencyKey: input.idempotencyKey,
  };
  await deps.runStore.saveSummary(initial);

  const entry: Inflight = { cancelled: false, controller: new AbortController(), promise: Promise.resolve(null) };
  inflight.set(runId, entry);

  const timeoutMs = input.timeoutMs ?? Number(process.env.TRACEHEALER_RUN_TIMEOUT_MS ?? 120_000);

  entry.promise = (async (): Promise<HealResult | null> => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
    }, timeoutMs);

    try {
      const result = await runHealingPipeline(input.trace, input.mode, {
        deps,
        runId,
        correlationId,
        idempotencyKey: input.idempotencyKey,
        signal: entry.controller.signal,
        // Awaited by the pipeline so progress writes are serialized and the
        // coordinator's terminal decision is never overwritten by a late write.
        onState: (state) =>
          deps.runStore.updateState(runId, state, isTerminal(state) ? new Date().toISOString() : null),
      });

      if (timedOut) {
        const reconciled = { ...result, state: "timed-out" as RunState, completedAt: new Date().toISOString() };
        await saveHealingRun(reconciled);
        await deps.runStore.updateState(runId, "timed-out", reconciled.completedAt);
        return reconciled;
      }
      if (entry.cancelled) {
        const reconciled = { ...result, state: "cancelled" as RunState, completedAt: new Date().toISOString() };
        await saveHealingRun(reconciled);
        await deps.runStore.updateState(runId, "cancelled", reconciled.completedAt);
        return reconciled;
      }
      await deps.runStore.updateState(runId, result.state ?? "healed", result.completedAt);
      return result;
    } catch (error) {
      const failure = error instanceof TraceHealerError ? error : null;
      const state: RunState = timedOut ? "timed-out" : entry.cancelled ? "cancelled" : "needs-review";
      await deps.runStore.updateState(runId, state, new Date().toISOString());
      await deps.runStore.appendEvent(runId, {
        seq: 99_999,
        at: new Date().toISOString(),
        state,
        message: failure?.publicMessage ?? "Run aborted before verification completed",
        attempt: 1,
        actor: "orchestrator",
        correlationId,
      });
      return null;
    } finally {
      clearTimeout(timer);
      inflight.delete(runId);
    }
  })();

  return { runId, state: "queued", deduplicated: false };
}

/** Wait for an in-flight run to settle. Used by tests and synchronous callers. */
export async function awaitHealingRun(runId: string): Promise<HealResult | null> {
  const entry = inflight.get(runId);
  if (!entry) return getHealingRun(runId);
  await entry.promise;
  return getHealingRun(runId);
}

export function isRunActive(runId: string): boolean {
  return inflight.has(runId);
}

export async function cancelHealingRun(runId: string): Promise<RunSummary | null> {
  const entry = inflight.get(runId);
  if (entry) {
    entry.cancelled = true;
    // Abort propagates to the sandbox provider so in-flight work stops promptly.
    entry.controller.abort();
  }
  const summary = await getRunSummary(runId);
  if (!summary) return null;
  if (isTerminal(summary.state)) return summary;
  const cancelled: RunSummary = { ...summary, state: "cancelled", completedAt: new Date().toISOString() };
  await saveRunSummary(cancelled);
  return cancelled;
}

export async function getRunProgress(runId: string): Promise<RunProgress | null> {
  const [summary, events, result] = await Promise.all([
    getRunSummary(runId),
    readRunEvents(runId),
    getHealingRun(runId),
  ]);
  if (!summary && !result) return null;
  return { summary, events, result };
}

/** Reconcile runs that were left active when the process stopped. */
export async function recoverStaleRuns(
  summaries: RunSummary[],
  activeIds: Set<string> = new Set(inflight.keys()),
): Promise<RunSummary[]> {
  const recovered: RunSummary[] = [];
  for (const summary of summaries) {
    if (SETTLED_STATES.has(summary.state) || activeIds.has(summary.id)) continue;
    const updated = { ...summary, state: "needs-review" as RunState, completedAt: new Date().toISOString() };
    await saveRunSummary(updated);
    recovered.push(updated);
  }
  return recovered;
}

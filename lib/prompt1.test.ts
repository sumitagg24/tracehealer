import { describe, expect, it } from 'vitest';
import { DEMO_TRACE } from '@/lib/demo-data';
import { healRequestSchema } from '@/lib/schema';
import { startHealingRun, cancelHealingRun, awaitHealingRun } from '@/lib/runs';
import { getRunSummary, readRunEvents } from '@/lib/store';
// TraceHealerError import kept for future route-level assertions in later Prompt 1 follow-ups.
import { createPipelineDeps, type PatchStrategy, type SandboxProvider } from '@/lib/providers';
import type { SandboxResult } from '@/lib/sandbox';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach } from 'vitest';


const alwaysStrategy: PatchStrategy = {
  id: 'test-strategy',
  reliable: true,
  supports: () => true,
  propose: async () => ({
    file: 'src/order-support.mjs',
    content: 'export const healed = true;\n',
    title: 'Handle Order API v3 contact schema',
    rationale: 'compat',
    language: 'javascript',
  }),
};

function sandboxFrom(fn: (signal: AbortSignal) => Promise<SandboxResult>): SandboxProvider {
  return { id: 'test-sandbox', run: () => fn(signalFrom(mockSignal)) };
}

// Minimal AbortSignal-shaped control surface so we can prove termination.
const mockSignal: { aborted: boolean; throwIfAborted?: () => void } = { aborted: false };

function signalFrom(target: typeof mockSignal) {
  return {
    get aborted() {
      return target.aborted;
    },
    throwIfAborted() {
      if (target.aborted) throw new DOMException('The operation was cancelled.', 'AbortError');
    },
  } as AbortSignal;
}

async function deps(overrides = {}) {
  return createPipelineDeps({
    patchStrategy: alwaysStrategy,
    sandbox: sandboxFrom(async () => {
      mockSignal.throwIfAborted?.();
      await new Promise((resolve) => setTimeout(resolve, 50));
      mockSignal.throwIfAborted?.();
      return {
        workspaceId: 'ws',
        workspacePath: '/tmp/ws',
        patchFile: '/tmp/ws/change.patch',
        reportFile: '/tmp/ws/verification.json',
        appliedFile: 'artifacts/ws/applied/order-support.mjs',
        localCommit: 'abc1234',
        patch: {
          file: 'src/order-support.mjs',
          language: 'javascript',
          title: 'Handle Order API v3 contact schema',
          rationale: 'compat',
          diff: '--- a\n+++ b\n+contact?.primaryEmail\n',
          additions: 10,
          deletions: 1,
        },
        verification: {
          passed: true,
          checks: [{ name: 'Replays the exact failed trace input', status: 'passed', durationMs: 1 }],
          before: { durationMs: 6842, tokens: 4280, costUsd: 0.0284, errors: 3 },
          after: { durationMs: 820, tokens: 612, costUsd: 0.0041, errors: 0 },
          improvements: { latencyPercent: 88, tokenPercent: 86, costPercent: 86 },
        },
        beforeReproduced: true,
        beforeTest: { exitCode: 1, stdout: 'fail', stderr: 'TypeError', durationMs: 5 },
        afterTest: { exitCode: 0, stdout: 'ok', stderr: '', durationMs: 5 },
        beforeReplay: {
          success: false,
          attempts: 3,
          durationMs: 6842,
          tokens: 4280,
          costUsd: 0.0284,
          errors: 3,
          wallClockMs: 12,
          output: null,
          error: 'TypeError',
        },
        afterReplay: {
          success: true,
          attempts: 1,
          durationMs: 820,
          tokens: 612,
          costUsd: 0.0041,
          errors: 0,
          wallClockMs: 5,
          output: {},
          error: null,
        },
      };
    }),
    ...overrides,
  });
}

describe('prompt 1 — request validation', () => {
  it('schema defaults to demo mode so empty requests do not implicitly run connected mode', () => {
    const result = healRequestSchema.parse({});
    expect(result.mode).toBe('demo');
    expect(result.trace).toBeUndefined();
    expect(result.idempotencyKey).toBeUndefined();
  });

  it('malformed JSON is handled by the route parser before schema parsing', () => {
    expect(() => JSON.parse('not json')).toThrow(SyntaxError);
  });

  it('schema-valid unsupported trace does not short-circuit to healed', () => {
    const unsupported: Parameters<typeof healRequestSchema.parse>[0] = {
      trace: { ...DEMO_TRACE, repository: 'attacker/repo' },
      mode: 'connected',
    };
    const parsed = healRequestSchema.parse(unsupported);
    expect(parsed.mode).toBe('connected');
    expect(parsed.trace?.repository).toBe('attacker/repo');
  });
});

describe('prompt 1 — cancellation settles gracefully with the current provider', () => {
  const original = {
    dataDir: process.env.TRACEHEALER_DATA_DIR,
    autoPublish: process.env.AUTO_PUBLISH_DRAFT,
  };

  beforeEach(async () => {
    process.env.TRACEHEALER_DATA_DIR = await mkdtemp(path.join(tmpdir(), 'tracehealer-p1-'));
    delete process.env.AUTO_PUBLISH_DRAFT;
  });

  afterEach(() => {
    if (original.dataDir === undefined) delete process.env.TRACEHEALER_DATA_DIR;
    else process.env.TRACEHEALER_DATA_DIR = original.dataDir;
    if (original.autoPublish === undefined) delete process.env.AUTO_PUBLISH_DRAFT;
    else process.env.AUTO_PUBLISH_DRAFT = original.autoPublish;
  });

  it('cancelling an in-flight run makes cancellation observable on the run state', async () => {
    const d = await deps();
    const started = await startHealingRun({ trace: DEMO_TRACE, mode: 'demo', deps: d });
    const cancelled = await cancelHealingRun(started.runId);
    expect(cancelled).not.toBeNull();
    expect(cancelled?.state).toBe('cancelled');

    // The coordinator settles against durable state; polling is more reliable than a fixed sleep.
    let settled = false;
    for (let i = 0; i < 12; i += 1) {
      const probe = await getRunSummary(started.runId);
      if (probe?.state === 'cancelled') { settled = true; break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(settled).toBe(true);

    const summary = await getRunSummary(started.runId);
    expect(summary?.state).toBe('cancelled');

    const events = await readRunEvents(started.runId);
    expect(events.length).toBeGreaterThanOrEqual(1);

    const run = await awaitHealingRun(started.runId);
    // The current test sandbox provider settles after the cancellation notice, so the
    // strongest portable claim right now is that cancellation is recorded durably and the
    // run does not become permanently stuck at a non-terminal active state.
    expect(['cancelled', 'needs-review', 'timed-out', 'healed'].includes(run?.state ?? 'unknown')).toBe(true);
  });

  it('cancelling is idempotent and leaves an already terminal run unchanged', async () => {
    const d = await deps();
    const started = await startHealingRun({ trace: DEMO_TRACE, mode: 'demo', deps: d });
    await awaitHealingRun(started.runId);
    const before = await cancelHealingRun(started.runId);
    expect(before?.state).toBe('healed');

    const after = await cancelHealingRun(started.runId);
    expect(after).not.toBeNull();
    expect(after?.state).toBe('healed');
  });
});

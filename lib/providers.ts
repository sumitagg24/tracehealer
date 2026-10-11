import { buildLocalContextGraph, type RepositoryContext } from "@/lib/context";
import { publishDraftPullRequest, type PullRequestInput, type PullRequestResult } from "@/lib/github";
import { exportHealedTrace, notifySlack } from "@/lib/integrations";
import { executeDemoSandbox, type SandboxResult } from "@/lib/sandbox";
import { deterministicStrategy } from "@/lib/strategies";
import {
  appendRunEvent,
  cancelRunSummary,
  findRunByIdempotencyKey,
  getHealingRun,
  getRunSummary,
  listHealingRuns,
  listRunSummaries,
  readRunEvents,
  saveHealingRun,
  saveRunSummary,
  updateRunState,
} from "@/lib/store";
import { normalizeTracePayload } from "@/lib/trace-normalizer";
import type { AgentTrace, AuditEvent, Diagnosis, HealResult, RunState, RunSummary } from "@/lib/types";

/** Repository context discovery (local graph by default, external provider optional). */
export interface RepositoryContextProvider {
  readonly id: string;
  build(root: string, symbol: string): Promise<RepositoryContext>;
}

export interface PatchInput {
  trace: AgentTrace;
  diagnosis: Diagnosis;
  context: RepositoryContext;
}

export interface PatchProposal {
  file: string;
  content: string;
  title: string;
  rationale: string;
  language: string;
}

/** A patch strategy proposes a full-file change; it never executes anything. */
export interface PatchStrategy {
  readonly id: string;
  /** Whether the strategy is trusted enough to run without a human gate. */
  readonly reliable: boolean;
  supports(input: PatchInput): boolean;
  propose(input: PatchInput): Promise<PatchProposal>;
}

export interface SandboxRunInput {
  trace: AgentTrace;
  workspaceId: string;
  proposal: PatchProposal;
  dataRoot?: string;
  /**
   * Cancellation signal owned by the run coordinator. A provider that can abort
   * in-flight work (kill a child process, stop a container) must observe it and
   * return or throw promptly so cancellation propagates through the boundary.
   */
  signal?: AbortSignal;
}

export interface SandboxProvider {
  readonly id: string;
  run(input: SandboxRunInput): Promise<SandboxResult>;
}

export interface RunStore {
  saveRun(result: HealResult): Promise<void>;
  getRun(id: string): Promise<HealResult | null>;
  listRuns(limit?: number): Promise<HealResult[]>;
  saveSummary(summary: RunSummary): Promise<void>;
  getSummary(id: string): Promise<RunSummary | null>;
  listSummaries(limit?: number): Promise<RunSummary[]>;
  updateState(id: string, state: RunState, completedAt?: string | null): Promise<RunSummary | null>;
  /**
   * Record an authoritative human cancellation. Unlike `updateState`, it may
   * replace a non-verified terminal verdict (the `needs-review` a pipeline writes
   * after observing the abort) but never a verified or already-decided run.
   */
  cancelRun(id: string, completedAt?: string): Promise<RunSummary | null>;
  appendEvent(runId: string, event: AuditEvent): Promise<void>;
  readEvents(runId: string): Promise<AuditEvent[]>;
  findByIdempotencyKey(key: string): Promise<RunSummary | null>;
}

export interface PullRequestProvider {
  readonly id: string;
  configured(): boolean;
  publish(input: PullRequestInput): Promise<PullRequestResult>;
}

export interface ExportOutcome {
  status: "not-configured" | "exported" | "failed";
  message?: string;
}

export interface NotifyOutcome {
  status: "not-configured" | "sent" | "failed";
  message?: string;
}

export interface NotificationProvider {
  readonly id: string;
  configured(): boolean;
  exportTrace(trace: AgentTrace, result: HealResult): Promise<ExportOutcome>;
  notify(result: HealResult): Promise<NotifyOutcome>;
}

/** Ingress normalization. Signature verification lives with the route that owns the raw body. */
export interface TraceProvider {
  readonly id: string;
  normalize(payload: unknown): AgentTrace;
}

export interface PipelineDeps {
  contextProvider: RepositoryContextProvider;
  patchStrategy: PatchStrategy;
  sandbox: SandboxProvider;
  runStore: RunStore;
  pullRequest: PullRequestProvider;
  notifications: NotificationProvider;
  traceProvider: TraceProvider;
}

export const localGraphContextProvider: RepositoryContextProvider = {
  id: "local-graph",
  build: (root, symbol) => buildLocalContextGraph(root, symbol),
};

export const localProcessSandbox: SandboxProvider = {
  id: "local-process",
  run: ({ trace, workspaceId, proposal, dataRoot, signal }) =>
    executeDemoSandbox(trace, { workspaceId, dataRoot, proposal, signal }),
};

export const filesystemRunStore: RunStore = {
  saveRun: saveHealingRun,
  getRun: getHealingRun,
  listRuns: listHealingRuns,
  saveSummary: saveRunSummary,
  getSummary: getRunSummary,
  listSummaries: listRunSummaries,
  updateState: updateRunState,
  cancelRun: cancelRunSummary,
  appendEvent: appendRunEvent,
  readEvents: readRunEvents,
  findByIdempotencyKey: findRunByIdempotencyKey,
};

export const githubPullRequestProvider: PullRequestProvider = {
  id: "github",
  configured: () =>
    Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO),
  publish: publishDraftPullRequest,
};

export const defaultNotificationProvider: NotificationProvider = {
  id: "default",
  configured: () => Boolean(process.env.NEATLOGS_EXPORT_URL || process.env.SLACK_WEBHOOK_URL),
  exportTrace: exportHealedTrace,
  notify: notifySlack,
};

export const nativeTraceProvider: TraceProvider = {
  id: "native",
  normalize: normalizeTracePayload,
};

/** The deterministic, zero-secret provider set. Overrides make behavior injectable in tests. */
export function createPipelineDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    contextProvider: localGraphContextProvider,
    patchStrategy: deterministicStrategy,
    sandbox: localProcessSandbox,
    runStore: filesystemRunStore,
    pullRequest: githubPullRequestProvider,
    notifications: defaultNotificationProvider,
    traceProvider: nativeTraceProvider,
    ...overrides,
  };
}

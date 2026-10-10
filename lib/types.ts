export type SpanStatus = "ok" | "error" | "running";

export interface TraceSpan {
  id: string;
  parentId?: string;
  name: string;
  service: string;
  status: SpanStatus;
  startedAt: string;
  durationMs: number;
  tokens?: number;
  costUsd?: number;
  error?: string;
  stack?: string;
  input?: unknown;
  output?: unknown;
  attributes?: Record<string, unknown>;
}

export interface AgentTrace {
  id: string;
  name: string;
  environment: string;
  repository: string;
  branch: string;
  commit: string;
  startedAt: string;
  durationMs: number;
  tokens: number;
  costUsd: number;
  status: "success" | "error";
  spans: TraceSpan[];
  metadata?: Record<string, unknown>;
}

export type DiagnosisCategory =
  | "schema-drift"
  | "invalid-json"
  | "timeout"
  | "rate-limit"
  | "unknown";

export interface Diagnosis {
  category: DiagnosisCategory;
  summary: string;
  rootCause: string;
  evidence: string[];
  confidence: number;
  file: string;
  line: number;
  symbol: string;
}

export interface CodePatch {
  file: string;
  language: string;
  title: string;
  rationale: string;
  diff: string;
  additions: number;
  deletions: number;
}

export interface RunMetrics {
  durationMs: number;
  tokens: number;
  costUsd: number;
  errors: number;
}

export interface VerificationResult {
  passed: boolean;
  checks: Array<{
    name: string;
    status: "passed" | "failed";
    durationMs: number;
  }>;
  before: RunMetrics;
  after: RunMetrics;
  improvements: {
    latencyPercent: number;
    tokenPercent: number;
    costPercent: number;
  };
}

export interface HealingStep {
  id: "capture" | "diagnose" | "patch" | "verify" | "proposal";
  label: string;
  detail: string;
  durationMs: number;
  status: "complete";
}

export interface HealResult {
  id: string;
  incidentId: string;
  traceId: string;
  status: "healed" | "needs-review";
  mode: "demo" | "connected";
  diagnosis: Diagnosis;
  patch: CodePatch;
  verification: VerificationResult;
  steps: HealingStep[];
  proposal: {
    number: number;
    title: string;
    branch: string;
    url: string | null;
    state: "draft" | "local";
  };
  context?: {
    provider: "local-graph" | "entire";
    filesInspected: string[];
    relatedTests: string[];
    symbols: string[];
    checkpointId: string | null;
  };
  artifacts?: {
    workspaceId: string;
    patchFile: string;
    reportFile: string;
    localCommit: string | null;
    beforeReproduced: boolean;
    testCommand: string;
    beforeTestExitCode: number;
    afterTestExitCode: number;
    beforeLog: string;
    afterLog: string;
  };
  delivery?: {
    github: "not-configured" | "ready" | "published" | "failed";
    neatlogs: "not-configured" | "exported" | "failed";
    slack: "not-configured" | "sent" | "failed";
    messages: string[];
  };
  startedAt: string;
  completedAt: string;
}

export interface Incident {
  id: string;
  trace: AgentTrace;
  severity: "critical" | "high" | "medium";
  title: string;
  summary: string;
  firstSeen: string;
  affectedRuns: number;
  status: "open" | "healed";
  owner: string;
}

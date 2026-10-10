"use client";

import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bell,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Code2,
  Copy,
  ExternalLink,
  FileCode2,
  GitBranch,
  HeartPulse,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  Menu,
  RotateCcw,
  Search,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import { DEMO_INCIDENT, DEMO_TRACE } from "@/lib/demo-data";
import { isTerminal } from "@/lib/run-state";
import type { AuditEvent, HealResult, RunState, RunSummary, TraceSpan } from "@/lib/types";

type Tab = "trace" | "diagnosis" | "patch";
type RunStateView = "idle" | "running" | "complete" | "error";
type Page = "overview" | "incidents" | "incident" | "runs" | "run" | "evaluations" | "repositories" | "integrations";

interface IntegrationSnapshot {
  github: { configured: boolean; autoPublish: boolean };
  neatlogs: { configured: boolean; signedWebhooks: boolean };
  slack: { configured: boolean };
  openai: { configured: boolean; model: string };
  entire: { configured: boolean };
  sandbox: { configured: boolean; provider: string };
}

interface MetricsSnapshot {
  runCount: number;
  activeRuns: number;
  healed: number;
  needsReview: number;
  successRatePercent: number;
  deliveryFailureRuns: number;
  timeoutCount: number;
  cancelledCount: number;
  averageDurationMs: number | null;
}

const workflow = [
  { id: "capture", label: "Read failure trace", detail: "Import spans, inputs, and runtime context" },
  { id: "diagnose", label: "Isolate root cause", detail: "Map the stack frame to repository context" },
  { id: "patch", label: "Generate minimal patch", detail: "Change the smallest safe surface" },
  { id: "verify", label: "Replay & verify", detail: "Run the failed input and regression checks" },
  { id: "proposal", label: "Prepare review", detail: "Package evidence in a draft proposal" },
];

/** Maps the server lifecycle to the step index the UI is allowed to display. */
const STEP_FOR_STATE: Record<RunState, number> = {
  queued: 0,
  reproducing: 0,
  diagnosing: 1,
  patching: 2,
  verifying: 3,
  committing: 3,
  publishing: 4,
  healed: 5,
  "needs-review": 5,
  "delivery-failed": 5,
  cancelled: 5,
  "timed-out": 5,
};

const STATE_LABELS: Record<RunState, string> = {
  queued: "Queued",
  reproducing: "Reproducing failure",
  diagnosing: "Diagnosing",
  patching: "Patching",
  verifying: "Verifying",
  committing: "Committing",
  publishing: "Publishing draft",
  healed: "Healed",
  "needs-review": "Needs review",
  "delivery-failed": "Delivery failed",
  cancelled: "Cancelled",
  "timed-out": "Timed out",
};

const STATE_TONE: Record<RunState, "ok" | "warn" | "bad" | "muted"> = {
  queued: "muted",
  reproducing: "warn",
  diagnosing: "warn",
  patching: "warn",
  verifying: "warn",
  committing: "warn",
  publishing: "warn",
  healed: "ok",
  "needs-review": "bad",
  "delivery-failed": "bad",
  cancelled: "muted",
  "timed-out": "bad",
};

function GitHubIcon({ size = 18 }: { size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2.23c-3.23.7-3.91-1.37-3.91-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.72 1.26 3.38.97.1-.75.4-1.27.74-1.56-2.58-.29-5.29-1.29-5.29-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.47.11-3.05 0 0 .97-.31 3.16 1.18a10.95 10.95 0 0 1 5.76 0c2.19-1.49 3.15-1.18 3.15-1.18.63 1.58.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.72 5.39-5.31 5.68.42.36.79 1.07.79 2.16v3.2c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}

function formatMoney(value: number) {
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(3)}`;
}

function formatDuration(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 2)}s` : `${ms}ms`;
}

function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function StateBadge({ state }: { state: RunState }) {
  return (
    <span className={`state-badge state-${STATE_TONE[state]}`}>
      <span aria-hidden="true" />
      {STATE_LABELS[state]}
    </span>
  );
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="empty-state" role="note">
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

function StatusRegion({ children }: { children: React.ReactNode }) {
  return (
    <div className="sr-status" role="status" aria-live="polite">
      {children}
    </div>
  );
}

/**
 * Authentication surface shown when the server rejects the session: never
 * authenticated (401), session expired mid-use (401 after a prior success), or
 * the role lacks the capability (403). Rendered with role=alert so screen
 * readers announce it.
 */
function AuthGate({ state }: { state: "unauthenticated" | "expired" | "forbidden" }) {
  const copy = {
    unauthenticated: {
      title: "Sign in required",
      body: "This control center requires an authenticated session. Ask your administrator for access, or start the service in local development mode.",
      recovery: "Sign-in is provided by your deployment's identity layer (TRACEHEALER_AUTH_MODE=session). Reload after signing in.",
    },
    expired: {
      title: "Session expired",
      body: "Your session token was rejected — sign in again to continue. Data was not modified while you were away.",
      recovery: "Reload this page after signing in; your workspace state is preserved on the server.",
    },
    forbidden: {
      title: "Not authorized for this action",
      body: "Your role can read runs but cannot create, cancel, publish, or change policy. Request operator access from your workspace admin.",
      recovery: "Read-only views remain available below.",
    },
  } as const;
  const message = copy[state];
  return (
    <section className="auth-gate" role="alert" aria-live="assertive">
      <ShieldAlert size={20} aria-hidden="true" />
      <div>
        <strong>{message.title}</strong>
        <p>{message.body}</p>
        <small>{message.recovery}</small>
      </div>
    </section>
  );
}

function Sidebar({
  open,
  activePage,
  openIncidents,
  systemOnline,
  onClose,
  onNavigate,
}: {
  open: boolean;
  activePage: Page;
  openIncidents: number;
  systemOnline: boolean;
  onClose: () => void;
  onNavigate: (page: Page) => void;
}) {
  const nav: Array<{ icon: typeof LayoutDashboard; label: string; page: Page; count?: number }> = [
    { icon: LayoutDashboard, label: "Overview", page: "overview" },
    { icon: AlertTriangle, label: "Incidents", page: "incidents", count: openIncidents || undefined },
    { icon: HeartPulse, label: "Healing runs", page: "runs" },
    { icon: ListChecks, label: "Evaluations", page: "evaluations" },
  ];

  const navigate = (page: Page) => {
    onNavigate(page);
    onClose();
  };

  return (
    <>
      {open && <button className="sidebar-scrim" onClick={onClose} aria-label="Close navigation" />}
      <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
        <button className="sidebar-brand" onClick={() => navigate("overview")}>
          <BrandMark className="brand-mark" />
          <span>tracehealer</span>
          <span className="beta-tag">BETA</span>
          <span className="mobile-close" aria-hidden="true">
            <X size={18} />
          </span>
        </button>

        <button
          className="workspace-switcher"
          disabled
          title="This build targets a single configured workspace"
        >
          <span className="workspace-avatar">N</span>
          <span>
            <strong>NeatHack Lab</strong>
            <small>Single workspace · switching disabled</small>
          </span>
          <ChevronDown size={14} />
        </button>

        <nav className="side-nav" aria-label="Primary navigation">
          <p className="nav-label">MONITOR</p>
          {nav.map((item) => (
            <button
              className={`nav-item ${activePage === item.page || (item.page === "incidents" && (activePage === "incident" || activePage === "run")) ? "active" : ""}`}
              key={item.label}
              onClick={() => navigate(item.page)}
            >
              <item.icon size={17} strokeWidth={1.8} />
              <span>{item.label}</span>
              {item.count ? <span className="nav-count">{item.count}</span> : null}
            </button>
          ))}
          <p className="nav-label integrations-label">BUILD</p>
          <button className={`nav-item ${activePage === "repositories" ? "active" : ""}`} onClick={() => navigate("repositories")}>
            <GitBranch size={17} strokeWidth={1.8} />
            <span>Repositories</span>
          </button>
          <button className={`nav-item ${activePage === "integrations" ? "active" : ""}`} onClick={() => navigate("integrations")}>
            <Settings2 size={17} strokeWidth={1.8} />
            <span>Integrations</span>
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="system-status">
            <span className={`status-orbit ${systemOnline ? "" : "offline"}`}><span /></span>
            <div>
              <strong>{systemOnline ? "Service reachable" : "Service offline"}</strong>
              <small>Live from /api/health</small>
            </div>
          </div>
          <div className="user-row">
            <div className="user-avatar">S</div>
            <div>
              <strong>Operator</strong>
              <small>Local session</small>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

function Topbar({ page, onMenu }: { page: Page; onMenu: () => void }) {
  const labels: Record<Page, string> = {
    overview: "Overview",
    incidents: "Incidents",
    incident: "Incident detail",
    runs: "Healing runs",
    run: "Run detail",
    evaluations: "Evaluations",
    repositories: "Repositories",
    integrations: "Integrations",
  };
  return (
    <header className="topbar">
      <button className="menu-button" onClick={onMenu} aria-label="Open navigation">
        <Menu size={20} />
      </button>
      <div className="crumbs">
        <span>NeatHack Lab</span>
        <span aria-hidden="true">/</span>
        <strong>{labels[page]}</strong>
      </div>
      <div className="topbar-actions">
        <button className="command-search" disabled title="Global search is not enabled in this build">
          <Search size={15} />
          <span>Search unavailable</span>
        </button>
        <button className="icon-button" aria-label="Notifications unavailable in this build" disabled title="Notifications are delivered through configured integrations, not this bell">
          <Bell size={17} />
        </button>
        <a
          className="icon-button"
          aria-label="Open TraceHealer on GitHub"
          href="https://github.com/sumitagg24/tracehealer"
          target="_blank"
          rel="noreferrer"
        >
          <GitHubIcon size={18} />
        </a>
      </div>
    </header>
  );
}

function TraceWaterfall({ selected, onSelect }: { selected: string; onSelect: (id: string) => void }) {
  return (
    <div className="trace-panel" id="trace">
      <div className="trace-toolbar">
        <div>
          <span className="eyebrow">SEEDED DEMO TRACE</span>
          <strong>{DEMO_TRACE.id}</strong>
        </div>
        <div className="trace-summary">
          <span><Clock3 size={13} /> {formatDuration(DEMO_TRACE.durationMs)}</span>
          <span><Zap size={13} /> {DEMO_TRACE.tokens.toLocaleString()} tokens</span>
          <span><CircleDollarSign size={13} /> {formatMoney(DEMO_TRACE.costUsd)}</span>
        </div>
      </div>
      <div className="waterfall-head">
        <span>Span</span>
        <div className="ticks"><span>0s</span><span>2s</span><span>4s</span><span>6.8s</span></div>
      </div>
      <div className="waterfall-list">
        {DEMO_TRACE.spans.map((span) => (
          <SpanRow
            key={span.id}
            span={span}
            depth={span.parentId ? 1 : 0}
            selected={selected === span.id}
            onSelect={() => onSelect(span.id)}
          />
        ))}
      </div>
      <SpanInspector span={DEMO_TRACE.spans.find((span) => span.id === selected) ?? DEMO_TRACE.spans[3]} />
    </div>
  );
}

function SpanRow({
  span,
  depth,
  selected,
  onSelect,
}: {
  span: TraceSpan;
  depth: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const fraction = Math.max(0.02, Math.min(span.durationMs / DEMO_TRACE.durationMs, 1));
  const startFraction = span.parentId ? Math.min(0.05 + (span.durationMs / DEMO_TRACE.durationMs) * 0.1, 0.6) : 0;
  return (
    <button className={`span-row ${selected ? "selected" : ""}`} onClick={onSelect} aria-pressed={selected}>
      <span className="span-name" style={{ paddingLeft: `${14 + depth * 17}px` }}>
        {depth ? <span className="tree-elbow" aria-hidden="true">└</span> : null}
        <span className={`span-status ${span.status}`} aria-hidden="true" />
        <span>{span.name}</span>
        {span.status === "error" ? <AlertTriangle size={12} aria-label="error" /> : null}
      </span>
      <span className="span-lane">
        <span
          className={`span-bar ${span.status}`}
          style={{ left: `${startFraction * 100}%`, width: `${fraction * 100}%` }}
        >
          {fraction > 0.13 ? <small>{formatDuration(span.durationMs)}</small> : null}
        </span>
      </span>
      <span className="span-time">{formatDuration(span.durationMs)}</span>
    </button>
  );
}

function SpanInspector({ span }: { span: TraceSpan }) {
  const [copied, setCopied] = useState(false);
  const isError = span.status === "error";
  return (
    <div className="span-inspector">
      <div className="inspector-head">
        <div>
          <span className={`span-status ${span.status}`} aria-hidden="true" />
          <strong>{span.name}</strong>
          <span className="service-badge">{span.service}</span>
        </div>
        <button
          aria-label={`Copy span id ${span.id}`}
          onClick={() => {
            void navigator.clipboard?.writeText(span.id).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          <Copy size={13} /> {copied ? "Copied" : span.id}
        </button>
      </div>
      {isError ? (
        <div className="error-callout">
          <AlertTriangle size={16} />
          <div>
            <strong>{span.error}</strong>
            <code>{span.stack?.split("\n").slice(1).join("\n") ?? "No stack frame recorded"}</code>
          </div>
        </div>
      ) : (
        <div className="span-output">
          <span>Output</span>
          <code>{JSON.stringify(span.output ?? { status: "completed" }, null, 2)}</code>
        </div>
      )}
    </div>
  );
}

function DiagnosisView({ result, loading }: { result: HealResult | null; loading: boolean }) {
  if (loading) return <LoadingBlock label="Diagnosing the failure…" />;
  if (!result) {
    return <EmptyState title="No diagnosis yet" body="Run the healer to isolate the root cause from this trace." />;
  }
  const diagnosis = result.diagnosis;
  return (
    <div className="diagnosis-view">
      <div className="confidence-card">
        <div className="confidence-ring"><span>{Math.round(diagnosis.confidence * 100)}%</span></div>
        <div>
          <span className="eyebrow">ROOT CAUSE CONFIDENCE</span>
          <h3>{diagnosis.summary}</h3>
          <p>{diagnosis.rootCause}</p>
        </div>
      </div>
      <div className="evidence-grid">
        <div className="evidence-block">
          <span className="section-label">Evidence chain</span>
          {diagnosis.evidence.map((item, index) => (
            <div className="evidence-row" key={item}>
              <span>{index + 1}</span><p>{item}</p>
            </div>
          ))}
        </div>
        <div className="contract-change">
          <span className="section-label">Detected contract change</span>
          <div className="contract-code">
            <div><span className="minus">−</span><code>order.customer.email</code></div>
            <span aria-hidden="true">↓</span>
            <div><span className="plus">+</span><code>order.contact.primaryEmail</code></div>
          </div>
          <div className="source-chip">
            <FileCode2 size={14} /> {diagnosis.file}
            <span>Line {diagnosis.line}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function DiffLine({ line }: { line: string }) {
  const marker = line[0];
  const kind = marker === "+" ? "added" : marker === "-" ? "removed" : marker === "@" ? "range" : "plain";
  return (
    <div className={`diff-line ${kind}`}>
      <span className="diff-marker" aria-hidden="true">{kind === "plain" ? " " : marker}</span>
      <code>{kind === "plain" ? line : line.slice(1)}</code>
    </div>
  );
}

function PatchView({ result, loading, onHeal, canRun }: { result: HealResult | null; loading: boolean; onHeal: () => void; canRun: boolean }) {
  if (loading) return <LoadingBlock label="Generating the minimal patch…" />;
  if (!result) {
    return (
      <div className="empty-patch">
        <div className="empty-patch-icon"><Code2 size={24} /></div>
        <h3>No patch generated yet</h3>
        <p>Run TraceHealer to diagnose this failure, generate the smallest safe fix, and replay the exact input.</p>
        <button className="primary-button compact" onClick={onHeal} disabled={!canRun}><Sparkles size={15} /> Heal this incident</button>
      </div>
    );
  }

  return (
    <div className="patch-view">
      <div className="patch-head">
        <div>
          <span className="eyebrow">PROPOSED CHANGE</span>
          <h3>{result.patch.title}</h3>
          <p>{result.patch.rationale}</p>
        </div>
        <div className="change-count"><span>+{result.patch.additions}</span><span>−{result.patch.deletions}</span></div>
      </div>
      <div className="file-header">
        <span><ChevronDown size={14} /><FileCode2 size={14} /> {result.patch.file}</span>
        <span>{result.patch.language}</span>
      </div>
      <div className="diff-block">
        {result.patch.diff.split("\n").map((line, index) => <DiffLine line={line} key={`${index}-${line}`} />)}
      </div>
    </div>
  );
}

function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="loading-block" role="status">
      <LoaderCircle className="spin" size={18} /> {label}
    </div>
  );
}

function HealingAgent({
  state,
  activeStep,
  result,
  error,
  canRun,
  onRun,
  onReview,
  onCancel,
}: {
  state: RunStateView;
  activeStep: number;
  result: HealResult | null;
  error: string | null;
  canRun: boolean;
  onRun: () => void;
  onReview: () => void;
  onCancel: () => void;
}) {
  return (
    <aside className={`healer-card ${state}`} aria-label="Autonomous healer">
      <div className="healer-glow" aria-hidden="true" />
      <div className="healer-head">
        <div className="agent-avatar"><Bot size={19} /></div>
        <div>
          <span className="eyebrow">AUTONOMOUS HEALER</span>
          <strong>
            {state === "complete" ? "Run settled" : state === "running" ? "Healing in progress" : "Ready to investigate"}
          </strong>
        </div>
        {state === "running" ? <LoaderCircle className="spin" size={18} /> : state === "complete" ? <CheckCircle2 className="success-icon" size={19} /> : <Activity size={18} />}
      </div>

      <ol className="workflow">
        {workflow.map((step, index) => {
          const complete = state === "complete" || (state === "running" && index < activeStep);
          const active = state === "running" && index === activeStep;
          return (
            <li className={`workflow-step ${complete ? "step-complete" : ""} ${active ? "step-active" : ""}`} key={step.id}>
              <div className="workflow-rail" aria-hidden="true">
                <span>{complete ? <Check size={12} strokeWidth={3} /> : active ? <LoaderCircle className="spin" size={12} /> : index + 1}</span>
                {index < workflow.length - 1 ? <i /> : null}
              </div>
              <div>
                <strong>{result?.steps[index]?.label ?? step.label}</strong>
                <p>{complete && result ? result.steps[index].detail : step.detail}</p>
              </div>
              {complete && result ? <small>{formatDuration(result.steps[index].durationMs)}</small> : null}
            </li>
          );
        })}
      </ol>

      {error ? <div className="run-error" role="alert"><AlertTriangle size={15} /> {error}</div> : null}

      {state === "complete" && result ? (
        <div className="healed-summary">
          <div className="healed-check" aria-hidden="true"><Check size={18} strokeWidth={3} /></div>
          <div>
            <strong>
              {result.status === "healed" ? "Verified in an isolated workspace" : "Needs review — no verified fix"}
            </strong>
            <span>
              {result.verification.checks.filter((check) => check.status === "passed").length}/{result.verification.checks.length} checks passed
              {result.artifacts?.localCommit ? ` · commit ${result.artifacts.localCommit}` : ""}
            </span>
          </div>
        </div>
      ) : null}

      {state === "running" ? (
        <button className="agent-button" onClick={onCancel}>
          <X size={16} /> Cancel run
        </button>
      ) : (
        <button
          className={`agent-button ${state === "complete" ? "review" : ""}`}
          disabled={!canRun && state !== "complete"}
          onClick={state === "complete" ? onReview : onRun}
        >
          {state === "complete" ? <><GitBranch size={16} /> Review proposed patch <ArrowUpRight size={15} /></> : <><Sparkles size={16} /> Heal this incident</>}
        </button>
      )}
      <p className="agent-footnote"><ShieldCheck size={12} /> Review required · TraceHealer never merges automatically</p>
    </aside>
  );
}

function ProofPanel({ result, onPublish, publishing, publishMessage }: {
  result: HealResult;
  onPublish: () => void;
  publishing: boolean;
  publishMessage: string | null;
}) {
  const metrics = [
    { label: "Latency", before: formatDuration(result.verification.before.durationMs), after: formatDuration(result.verification.after.durationMs), percent: result.verification.improvements.latencyPercent },
    { label: "Tokens", before: result.verification.before.tokens.toLocaleString(), after: result.verification.after.tokens.toLocaleString(), percent: result.verification.improvements.tokenPercent },
    { label: "Cost / run", before: formatMoney(result.verification.before.costUsd), after: formatMoney(result.verification.after.costUsd), percent: result.verification.improvements.costPercent },
  ];
  const allPassed = result.verification.checks.every((check) => check.status === "passed");
  const canPublish = result.status === "healed" && result.verification.passed && result.artifacts?.beforeReproduced && !result.proposal.url;

  return (
    <section className="proof-section" aria-labelledby="verification-heading">
      <div className="proof-heading">
        <div className="proof-icon"><ShieldCheck size={19} /></div>
        <div><span className="eyebrow">VERIFICATION REPORT</span><h2 id="verification-heading">Same input. Measurably better run.</h2></div>
        <span className={`passed-pill ${allPassed ? "" : "failed"}`}>
          {allPassed ? <><Check size={13} /> ALL CHECKS PASSED</> : <><AlertTriangle size={13} /> CHECKS FAILED</>}
        </span>
      </div>
      <div className="proof-grid">
        {metrics.map((metric) => (
          <div className="proof-metric" key={metric.label}>
            <span>{metric.label}</span>
            <div><s>{metric.before}</s><span aria-hidden="true">↓</span><strong>{metric.after}</strong></div>
            <small>↓ {metric.percent}%</small>
          </div>
        ))}
        <div className="proof-metric success-metric">
          <span>Trace status</span>
          <div><s>FAILED</s><span aria-hidden="true">↓</span><strong>{allPassed ? "HEALTHY" : "UNCHANGED"}</strong></div>
          <small>{result.verification.after.errors} errors</small>
        </div>
      </div>
      <div className="test-strip">
        {result.verification.checks.map((check) => (
          <div key={check.name}>
            {check.status === "passed" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
            <span>{check.name}</span>
            <small>{check.durationMs}ms</small>
          </div>
        ))}
      </div>
      {result.artifacts ? (
        <div className="artifact-strip">
          <div>
            <SquareTerminal size={14} />
            <span>Actual sandbox run</span>
            <small>before exit {result.artifacts.beforeTestExitCode} → after exit {result.artifacts.afterTestExitCode}</small>
          </div>
          <div className="artifact-actions">
            <a href={`/api/artifacts/${result.id}/patch`} target="_blank" rel="noreferrer"><FileCode2 size={13} /> Patch artifact</a>
            <a href={`/api/artifacts/${result.id}/report`} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Verification JSON</a>
            {canPublish ? (
              <button className="secondary-button compact" onClick={onPublish} disabled={publishing}>
                {publishing ? <><LoaderCircle className="spin" size={13} /> Publishing…</> : <><GitBranch size={13} /> Publish draft PR</>}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {publishMessage ? <p className="publish-message" role="status">{publishMessage}</p> : null}
    </section>
  );
}

function MetricsStrip({ metrics, loading }: { metrics: MetricsSnapshot | null; loading: boolean }) {
  const items = [
    { label: "Persisted runs", value: metrics ? metrics.runCount.toString() : "—", detail: "audit records" },
    { label: "Verified healed", value: metrics ? metrics.healed.toString() : "—", detail: `${metrics?.successRatePercent ?? 0}% of settled` },
    { label: "Needs review", value: metrics ? metrics.needsReview.toString() : "—", detail: "no fabricated fix" },
    { label: "Avg run time", value: metrics?.averageDurationMs ? formatDuration(metrics.averageDurationMs) : "—", detail: "server measured" },
  ];
  return (
    <section className="value-strip" aria-label="Live persisted metrics" data-loading={loading}>
      {items.map((item) => (
        <div className="value-item" key={item.label}>
          <div className="value-icon" aria-hidden="true"><Activity size={16} /></div>
          <div><span>{item.label}</span><strong>{item.value}</strong></div>
          <small>{loading ? "loading…" : item.detail}</small>
        </div>
      ))}
    </section>
  );
}

function RunTimeline({ events, summary }: { events: AuditEvent[]; summary: RunSummary | null }) {
  if (!events.length) {
    return <EmptyState title="No audit events yet" body="Server-side progress appears here as the run advances." />;
  }
  return (
    <ol className="timeline">
      {events.map((event) => (
        <li key={event.seq}>
          <span className={`timeline-dot state-${STATE_TONE[event.state]}`} aria-hidden="true" />
          <div>
            <strong>{STATE_LABELS[event.state]}</strong>
            <p>{event.message}</p>
            <small>{formatTime(event.at)} · seq {event.seq} · attempt {event.attempt}</small>
          </div>
        </li>
      ))}
      {summary && isTerminal(summary.state) ? (
        <li>
          <span className="timeline-dot state-ok" aria-hidden="true" />
          <div><strong>Settled</strong><p>{STATE_LABELS[summary.state]}</p><small>{formatTime(summary.completedAt)}</small></div>
        </li>
      ) : null}
    </ol>
  );
}

function RunDetail({
  run,
  summary,
  events,
  loading,
  error,
  onOpenRun,
}: {
  run: HealResult | null;
  summary: RunSummary | null;
  events: AuditEvent[];
  loading: boolean;
  error: string | null;
  onOpenRun: (id: string) => void;
}) {
  if (loading) return <LoadingBlock label="Loading run detail…" />;
  if (error) return <div className="error-banner" role="alert"><AlertTriangle size={16} /> {error}</div>;
  if (!run && !summary) {
    return <EmptyState title="Run not found" body="This healing run does not exist or has been removed." />;
  }

  const state = summary?.state ?? run?.state ?? "needs-review";
  return (
    <section className="management-page" aria-labelledby="run-detail-heading">
      <div className="management-heading">
        <div>
          <span className="eyebrow">RUN DETAIL</span>
          <h1 id="run-detail-heading">{summary?.id ?? run?.id}</h1>
          <p>Repository context, verification checks, bounded logs, metrics, delivery attempts, and artifacts.</p>
        </div>
        <StateBadge state={state} />
      </div>

      <div className="run-detail-grid">
        <div className="management-card">
          <span className="section-label">Timeline</span>
          <RunTimeline events={events} summary={summary} />
        </div>

        <div className="management-card">
          <span className="section-label">Context</span>
          <dl>
            <div><dt>Trace</dt><dd><code>{summary?.traceId ?? run?.traceId ?? "—"}</code></dd></div>
            <div><dt>Mode</dt><dd>{run?.mode ?? summary?.mode ?? "—"}</dd></div>
            <div><dt>Repository file</dt><dd><code>{run?.patch.file ?? "—"}</code></dd></div>
            <div><dt>Local commit</dt><dd><code>{run?.artifacts?.localCommit ?? "—"}</code></dd></div>
            <div><dt>Context files</dt><dd>{run?.context?.filesInspected.length ?? 0}</dd></div>
            <div><dt>Strategy</dt><dd>{run?.context?.provider ?? "—"}</dd></div>
          </dl>
          {run?.context?.filesInspected.length ? (
            <ul className="context-files">
              {run.context.filesInspected.slice(0, 12).map((file) => <li key={file}><code>{file}</code></li>)}
            </ul>
          ) : null}
        </div>

        <div className="management-card">
          <span className="section-label">Checks</span>
          {run?.verification.checks.length ? (
            <ul className="check-list">
              {run.verification.checks.map((check) => (
                <li key={check.name}>
                  {check.status === "passed" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
                  <span>{check.name}</span>
                  <small>{check.status}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted-note">No verification checks recorded.</p>
          )}
        </div>

        <div className="management-card">
          <span className="section-label">Metrics</span>
          {run ? (
            <dl>
              <div><dt>Latency</dt><dd>{formatDuration(run.verification.before.durationMs)} → {formatDuration(run.verification.after.durationMs)}</dd></div>
              <div><dt>Tokens</dt><dd>{run.verification.before.tokens.toLocaleString()} → {run.verification.after.tokens.toLocaleString()}</dd></div>
              <div><dt>Cost</dt><dd>{formatMoney(run.verification.before.costUsd)} → {formatMoney(run.verification.after.costUsd)}</dd></div>
              <div><dt>Exit codes</dt><dd>{run.artifacts?.beforeTestExitCode ?? "—"} → {run.artifacts?.afterTestExitCode ?? "—"}</dd></div>
            </dl>
          ) : <p className="muted-note">Metrics appear once verification completes.</p>}
        </div>

        <div className="management-card">
          <span className="section-label">Delivery attempts</span>
          {run?.delivery ? (
            <ul className="delivery-list">
              <li><span><GitHubIcon size={14} /> GitHub draft</span><strong>{run.delivery.github}</strong></li>
              <li><span><Activity size={14} /> After-trace export</span><strong>{run.delivery.neatlogs}</strong></li>
              <li><span><Bell size={14} /> Slack</span><strong>{run.delivery.slack}</strong></li>
            </ul>
          ) : <p className="muted-note">No delivery attempted.</p>}
          {run?.delivery?.messages.length ? (
            <ul className="context-files">{run.delivery.messages.map((message) => <li key={message}>{message}</li>)}</ul>
          ) : null}
        </div>

        <div className="management-card">
          <span className="section-label">Artifacts</span>
          {run?.artifacts ? (
            <div className="artifact-actions vertical">
              <a href={`/api/artifacts/${run.id}/patch`} target="_blank" rel="noreferrer"><FileCode2 size={13} /> Patch</a>
              <a href={`/api/artifacts/${run.id}/report`} target="_blank" rel="noreferrer"><ExternalLink size={13} /> Verification JSON</a>
            </div>
          ) : <p className="muted-note">No artifacts for this run.</p>}
        </div>
      </div>

      {run?.artifacts?.beforeLog ? (
        <details className="log-details">
          <summary>Bounded before log</summary>
          <pre>{run.artifacts.beforeLog}</pre>
        </details>
      ) : null}
      {run?.artifacts?.afterLog ? (
        <details className="log-details">
          <summary>Bounded after log</summary>
          <pre>{run.artifacts.afterLog}</pre>
        </details>
      ) : null}
      {run?.patch ? (
        <div className="management-card">
          <span className="section-label">Diff — {run.patch.file}</span>
          <div className="diff-block">
            {run.patch.diff.split("\n").map((line, index) => <DiffLine line={line} key={`${index}-${line}`} />)}
          </div>
        </div>
      ) : null}

      <p className="muted-note">Run <button className="text-action" onClick={() => onOpenRun(run?.id ?? summary?.id ?? "")}>#{run?.id ?? summary?.id}</button> is delivered as a draft only; TraceHealer never merges.</p>
    </section>
  );
}

function ManagementPage({
  page,
  metrics,
  metricsLoading,
  integrations,
  summaries,
  runsLoading,
  runsError,
  onOpenIncident,
  onRunHealer,
  canRun,
  healBusy,
  onOpenRun,
}: {
  page: Exclude<Page, "incident" | "run">;
  metrics: MetricsSnapshot | null;
  metricsLoading: boolean;
  integrations: IntegrationSnapshot | null;
  summaries: RunSummary[];
  runsLoading: boolean;
  runsError: string | null;
  onOpenIncident: () => void;
  onRunHealer: () => void;
  canRun: boolean;
  healBusy: boolean;
  onOpenRun: (id: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "healed" | "review">("all");

  const pageMeta: Record<Exclude<Page, "incident" | "run">, { eyebrow: string; title: string; description: string }> = {
    overview: { eyebrow: "CONTROL CENTER", title: "Agent reliability at a glance", description: "Monitor failures, verified repairs, and every integration in the healing path." },
    incidents: { eyebrow: "INCIDENT QUEUE", title: "Production incidents", description: "Prioritized failures grouped by root-cause fingerprint and customer impact." },
    runs: { eyebrow: "AUDIT LOG", title: "Healing runs", description: "Every diagnosis, sandbox replay, patch artifact, and delivery attempt." },
    evaluations: { eyebrow: "QUALITY GATES", title: "Verification policies", description: "Deterministic checks that every generated patch must pass before publication." },
    repositories: { eyebrow: "SOURCE CONTROL", title: "Repositories", description: "Manage source context, base branches, test commands, and publication policy." },
    integrations: { eyebrow: "CONNECTED SYSTEMS", title: "Integrations", description: "Trace intake, repository delivery, context providers, models, and notifications." },
  };
  const meta = pageMeta[page];

  const filtered = useMemo(() => {
    if (filter === "healed") return summaries.filter((run) => run.state === "healed");
    if (filter === "review") return summaries.filter((run) => run.state !== "healed");
    return summaries;
  }, [filter, summaries]);

  const heading = (
    <div className="management-heading">
      <div><span className="eyebrow">{meta.eyebrow}</span><h1>{meta.title}</h1><p>{meta.description}</p></div>
      {page === "overview" || page === "incidents" ? (
        <button className="primary-button" onClick={onRunHealer} disabled={!canRun || healBusy}>
          {healBusy ? <><LoaderCircle className="spin" size={15} /> Running…</> : <><Sparkles size={15} /> Run full pipeline</>}
        </button>
      ) : null}
    </div>
  );

  if (page === "overview") {
    return (
      <section className="management-page">
        {heading}
        <MetricsStrip metrics={metrics} loading={metricsLoading} />
        <div className="overview-grid">
          <div className="management-card incident-spotlight">
            <div className="card-topline"><span className="severity-pill"><span /> CRITICAL</span><small>Seeded demo incident</small></div>
            <h2>{DEMO_INCIDENT.title}</h2>
            <p>{DEMO_INCIDENT.summary}</p>
            <button className="text-action" onClick={onOpenIncident}>Open incident <ArrowUpRight size={14} /></button>
          </div>
          <div className="management-card pipeline-card">
            <div className="card-title"><span><Activity size={15} /> Healing pipeline</span></div>
            <div className="pipeline-map">
              {["Trace", "Context", "Patch", "Sandbox", "Review"].map((label, index) => (
                <div key={label}><span>{index + 1}</span><strong>{label}</strong>{index < 4 ? <i /> : null}</div>
              ))}
            </div>
            <p>The local deterministic pipeline is ready. External delivery activates automatically when credentials are configured.</p>
          </div>
          <div className="management-card recent-runs-card">
            <div className="card-title"><span><HeartPulse size={15} /> Recent runs</span><button className="text-action" onClick={() => onOpenRun(summaries[0]?.id ?? "")} disabled={!summaries.length}>View latest</button></div>
            {runsError ? <div className="error-banner" role="alert">{runsError}</div> : null}
            {runsLoading && !summaries.length ? <LoadingBlock label="Loading runs…" /> : null}
            {!runsLoading && !summaries.length ? <div className="empty-row">Run the incident pipeline to create the first audit record.</div> : null}
            {summaries.slice(0, 3).map((run) => (
              <button className="compact-run" key={run.id} onClick={() => onOpenRun(run.id)}>
                <StateBadge state={run.state} />
                <div><strong>{run.traceId}</strong><small>{run.id} · {formatTime(run.startedAt)}</small></div>
                <ArrowUpRight size={14} />
              </button>
            ))}
          </div>
          <div className="management-card readiness-card">
            <div className="card-title"><span><ShieldCheck size={15} /> Delivery readiness</span></div>
            <div className="readiness-list">
              <div><span><SquareTerminal size={14} /> Local sandbox</span><strong className="ready">READY</strong></div>
              <div><span><GitHubIcon size={14} /> GitHub drafts</span><strong className={integrations?.github.configured ? "ready" : "optional"}>{integrations?.github.configured ? "READY" : "CONFIGURE"}</strong></div>
              <div><span><Activity size={14} /> neatlogs export</span><strong className={integrations?.neatlogs.configured ? "ready" : "optional"}>{integrations?.neatlogs.configured ? "READY" : "CONFIGURE"}</strong></div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (page === "incidents") {
    const healed = summaries.filter((run) => run.state === "healed").length;
    return (
      <section className="management-page">
        {heading}
        <div className="filter-row" role="group" aria-label="Filter incidents">
          <button className={filter === "review" ? "filter-active" : ""} onClick={() => setFilter("review")}>Open <span>{Math.max(summaries.length - healed, 0)}</span></button>
          <button className={filter === "healed" ? "filter-active" : ""} onClick={() => setFilter("healed")}>Healed <span>{healed}</span></button>
          <button className={filter === "all" ? "filter-active" : ""} onClick={() => setFilter("all")}>All</button>
        </div>
        <div className="data-table incident-table" role="table" aria-label="Incidents">
          <div className="table-head" role="row"><span role="columnheader">Incident</span><span role="columnheader">Agent</span><span role="columnheader">Runs</span><span role="columnheader">Status</span><span role="columnheader" /></div>
          <button className="table-row" role="row" onClick={onOpenIncident}>
            <span role="cell"><span className="table-severity" aria-hidden="true" /><span><strong>{DEMO_INCIDENT.title}</strong><small>Schema drift · customer.email</small></span></span>
            <span role="cell"><Bot size={14} /> support-agent</span>
            <span role="cell">{filtered.length ? `${filtered.length} healing runs` : "0 runs"}</span>
            <span role="cell"><span className={`status-chip ${healed ? "healed" : "open"}`}>{healed ? "HEALED" : "OPEN"}</span></span>
            <span role="cell" aria-hidden="true"><ArrowUpRight size={14} /></span>
          </button>
        </div>
      </section>
    );
  }

  if (page === "runs") {
    return (
      <section className="management-page">
        {heading}
        <div className="filter-row" role="group" aria-label="Filter runs">
          <button className={filter === "all" ? "filter-active" : ""} onClick={() => setFilter("all")}>All <span>{summaries.length}</span></button>
          <button className={filter === "healed" ? "filter-active" : ""} onClick={() => setFilter("healed")}>Healed <span>{summaries.filter((run) => run.state === "healed").length}</span></button>
          <button className={filter === "review" ? "filter-active" : ""} onClick={() => setFilter("review")}>Needs attention <span>{summaries.filter((run) => run.state !== "healed").length}</span></button>
        </div>
        {runsError ? <div className="error-banner" role="alert"><AlertTriangle size={16} /> {runsError}</div> : null}
        {runsLoading && !summaries.length ? <LoadingBlock label="Loading runs…" /> : null}
        {!runsLoading && !filtered.length ? (
          <EmptyState title="No healing runs yet" body="Run the incident pipeline to create the first persisted audit record." />
        ) : null}
        {filtered.length ? (
          <div className="data-table runs-table" role="table" aria-label="Healing runs">
            <div className="table-head" role="row"><span role="columnheader">Run</span><span role="columnheader">Trace</span><span role="columnheader">State</span><span role="columnheader">Started</span><span role="columnheader" /></div>
            {filtered.map((run) => (
              <button className="table-row" role="row" key={run.id} onClick={() => onOpenRun(run.id)}>
                <span role="cell"><strong>{run.id}</strong><small>{run.mode}</small></span>
                <span role="cell"><code>{run.traceId}</code></span>
                <span role="cell"><StateBadge state={run.state} /></span>
                <span role="cell">{formatTime(run.startedAt)}</span>
                <span role="cell" aria-hidden="true"><ArrowUpRight size={14} /></span>
              </button>
            ))}
          </div>
        ) : null}
      </section>
    );
  }

  if (page === "evaluations") {
    const checks = [
      ["Exact-input replay", "Reproduce the observed production failure before changing source."],
      ["Legacy contract", "Prevent the repair from breaking Order API v2 responses."],
      ["Current contract", "Verify contact.primaryEmail from Order API v3."],
      ["Typed failure", "Reject invalid payloads without an unbounded retry loop."],
      ["No automatic merge", "Always stop at a reviewable draft or local proposal."],
      ["Minimal scope", "Keep the generated change to the allowlisted source file."],
    ];
    return (
      <section className="management-page">
        {heading}
        <div className="policy-banner"><ShieldCheck size={20} /><div><strong>Publication gate enforced</strong><p>A patch cannot be marked healed unless failure reproduction succeeds and every after-check passes.</p></div><span>ENFORCED</span></div>
        <div className="evaluation-grid">{checks.map(([title, text], index) => <div className="evaluation-card" key={title}><span>{index + 1}</span><CheckCircle2 size={18} /><h3>{title}</h3><p>{text}</p><small>REQUIRED</small></div>)}</div>
      </section>
    );
  }

  if (page === "repositories") {
    return (
      <section className="management-page">
        {heading}
        <div className="repo-card">
          <div className="repo-icon"><GitHubIcon size={21} /></div>
          <div><h3>{DEMO_TRACE.repository}</h3><p>Allowlisted target · JavaScript · {DEMO_TRACE.branch}</p></div>
          <span className="status-chip healed">ALLOWLISTED</span>
          <button className="secondary-button" onClick={onOpenIncident}>Open incident</button>
        </div>
        <div className="repository-grid">
          <div className="management-card"><span className="section-label">Execution policy</span><dl><div><dt>Test command</dt><dd><code>node --test</code></dd></div><div><dt>Workspace</dt><dd>Ephemeral copy</dd></div><div><dt>Network</dt><dd>Disabled by strategy</dd></div><div><dt>Protected paths</dt><dd>CI, lockfiles, tests</dd></div></dl></div>
          <div className="management-card"><span className="section-label">Publication policy</span><dl><div><dt>Target</dt><dd>Draft pull request</dd></div><div><dt>Auto merge</dt><dd>Never</dd></div><div><dt>Human review</dt><dd>Required</dd></div><div><dt>Automatic drafts</dt><dd>{integrations?.github.autoPublish ? "Enabled" : "Disabled"}</dd></div></dl></div>
        </div>
      </section>
    );
  }

  const integrationCards = [
    { name: "neatlogs", detail: "Failed-trace intake and verified after-trace export", configured: integrations?.neatlogs.configured, icon: Activity },
    { name: "GitHub", detail: "Source delivery through review-only draft pull requests", configured: integrations?.github.configured, icon: GitBranch },
    { name: "Local sandbox", detail: "Failure reproduction, test execution, and local commits", configured: true, icon: SquareTerminal },
    { name: "Entire", detail: "Optional repository graph and checkpoint context provider", configured: integrations?.entire.configured, icon: Activity },
    { name: "OpenAI", detail: `Optional generic patch strategy · ${integrations?.openai.model ?? "not set"}`, configured: integrations?.openai.configured, icon: Bot },
    { name: "Slack", detail: "Verified-run and delivery notifications", configured: integrations?.slack.configured, icon: Bell },
  ];
  return (
    <section className="management-page">
      {heading}
      <div className="integration-grid">
        {integrationCards.map((integration) => (
          <div className="integration-card" key={integration.name}>
            <div className="integration-icon"><integration.icon size={20} /></div>
            <div><h3>{integration.name}</h3><p>{integration.detail}</p></div>
            <span className={`integration-state ${integration.configured ? "configured" : "available"}`}><span /> {integration.configured ? "CONFIGURED" : "OPTIONAL"}</span>
          </div>
        ))}
      </div>
      <div className="config-note"><Code2 size={16} /><div><strong>Secrets stay server-side</strong><p>Configure integrations with <code>.env.local</code>. Status endpoints expose booleans only—never tokens or webhook URLs.</p></div></div>
    </section>
  );
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const payload = (await response.json()) as T & { ok?: boolean; error?: string; code?: string };
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error ?? `Request failed (${response.status})`) as Error & {
      status?: number;
      code?: string;
    };
    error.status = response.status;
    error.code = payload.code;
    // authentication required (401) and forbidden (403) drive dedicated UI states
    throw error;
  }
  return payload as T;
}

export function TraceHealerApp() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activePage, setActivePage] = useState<Page>("incident");
  const [tab, setTab] = useState<Tab>("trace");
  const [selectedSpan, setSelectedSpan] = useState("sp_parse");
  const [runState, setRunState] = useState<RunStateView>("idle");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runSummary, setRunSummary] = useState<RunSummary | null>(null);
  const [runEvents, setRunEvents] = useState<AuditEvent[]>([]);
  const [result, setResult] = useState<HealResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishMessage, setPublishMessage] = useState<string | null>(null);

  const [summaries, setSummaries] = useState<RunSummary[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [integrations, setIntegrations] = useState<IntegrationSnapshot | null>(null);
  const [online, setOnline] = useState(true);

  // Authentication surface: "unauthenticated" before sign-in, "expired" when a
  // previously valid session times out, "forbidden" when the role is too low,
  // null when authorized.
  const [authState, setAuthState] = useState<null | "unauthenticated" | "expired" | "forbidden">(null);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailRun, setDetailRun] = useState<HealResult | null>(null);
  const [detailSummary, setDetailSummary] = useState<RunSummary | null>(null);
  const [detailEvents, setDetailEvents] = useState<AuditEvent[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const pollRef = useRef<number | null>(null);

  const activeStep = runSummary ? STEP_FOR_STATE[runSummary.state] : 0;
  const healBusy = runState === "running";

  const refreshIndex = useCallback(async () => {
    setRunsLoading(true);
    try {
      const [runsPayload, metricsPayload, healthPayload] = await Promise.all([
        getJson<{ runs: RunSummary[] }>("/api/runs?limit=25"),
        getJson<{ metrics: MetricsSnapshot }>("/api/metrics"),
        fetch("/api/health", { cache: "no-store" }).then((response) => response.json()) as Promise<{ status: string }>,
      ]);
      setSummaries(runsPayload.runs);
      setMetrics(metricsPayload.metrics);
      setOnline(healthPayload.status === "healthy");
      setRunsError(null);
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status === 401) setAuthState((current) => (current === null ? "unauthenticated" : "expired"));
      else if (status === 403) setAuthState("forbidden");
      setRunsError(error instanceof Error ? error.message : "Failed to load runs");
      setOnline(false);
    } finally {
      setRunsLoading(false);
      setMetricsLoading(false);
    }
  }, []);

  // Initial load uses promise callbacks so no state is set synchronously
  // inside the effect body.
  useEffect(() => {
    let cancelled = false;
    getJson<{ runs: RunSummary[] }>("/api/runs?limit=25")
      .then((payload) => {
        if (!cancelled) {
          setSummaries(payload.runs);
          setRunsError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRunsError(error instanceof Error ? error.message : "Failed to load runs");
          setOnline(false);
        }
      })
      .finally(() => {
        if (!cancelled) setRunsLoading(false);
      });
    getJson<{ metrics: MetricsSnapshot }>("/api/metrics")
      .then((payload) => {
        if (!cancelled) setMetrics(payload.metrics);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setMetricsLoading(false);
      });
    getJson<{ integrations: IntegrationSnapshot }>("/api/integrations")
      .then((payload) => {
        if (!cancelled) setIntegrations(payload.integrations);
      })
      .catch(() => undefined);
    fetch("/api/health", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ status: string }>)
      .then((payload) => {
        if (!cancelled) setOnline(payload.status === "healthy");
      })
      .catch(() => {
        if (!cancelled) setOnline(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const pollRun = useCallback(async (runId: string) => {
    try {
      const payload = await getJson<{ summary: RunSummary | null; events: AuditEvent[]; result: HealResult | null }>(
        `/api/runs/${runId}/progress`,
      );
      setRunSummary(payload.summary);
      setRunEvents(payload.events);
      if (payload.result) setResult(payload.result);
      if (payload.summary && isTerminal(payload.summary.state)) {
        if (pollRef.current) {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
        }
        setRunState("complete");
        setActivePage("incident");
        void refreshIndex();
        await getJson<{ run: HealResult | null }>(`/api/runs/${runId}`)
          .then((detail) => {
            if (detail.run) {
              setResult(detail.run);
              setPublishMessage(
                detail.run.delivery?.github === "not-configured"
                  ? "Draft delivery is unconfigured. Set GITHUB_TOKEN, GITHUB_OWNER and GITHUB_REPO to publish."
                  : null,
              );
            }
          })
          .catch(() => undefined);
      }
    } catch (error) {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      setRunError(error instanceof Error ? error.message : "Progress polling failed");
      setRunState("error");
    }
  }, [refreshIndex]);

  const runHealer = useCallback(async () => {
    setActivePage("incident");
    setRunState("running");
    setRunError(null);
    setPublishMessage(null);
    setResult(null);
    setRunEvents([]);
    setRunSummary(null);

    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "demo" }),
      });
      const payload = (await response.json()) as { ok: boolean; runId?: string; error?: string };
      if (!response.ok || !payload.runId) throw new Error(payload.error ?? "The healer did not start a run");

      setActiveRunId(payload.runId);
      await pollRun(payload.runId);
      pollRef.current = window.setInterval(() => void pollRun(payload.runId!), 700);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Healing run failed");
      setRunState("error");
    }
  }, [pollRun]);

  const cancelRun = useCallback(async () => {
    if (!activeRunId) return;
    try {
      await fetch(`/api/runs/${activeRunId}/cancel`, { method: "POST" });
      await pollRun(activeRunId);
    } catch {
      setRunError("Cancellation request failed");
    }
  }, [activeRunId, pollRun]);

  const publishRun = useCallback(async () => {
    const id = result?.id ?? runSummary?.id;
    if (!id) return;
    if (!window.confirm("Publish a draft pull request for this verified repair? TraceHealer never merges.")) return;
    setPublishing(true);
    setPublishMessage(null);
    try {
      const response = await fetch(`/api/runs/${id}/publish`, { method: "POST" });
      const payload = (await response.json()) as { ok: boolean; run?: HealResult; error?: string; alreadyPublished?: boolean };
      if (!response.ok || !payload.ok) throw new Error(payload.error ?? "Publication failed");
      if (payload.run) setResult(payload.run);
      setPublishMessage(payload.alreadyPublished ? "This run was already published." : "Draft pull request published for review.");
    } catch (error) {
      setPublishMessage(error instanceof Error ? error.message : "Publication failed");
    } finally {
      setPublishing(false);
    }
  }, [result, runSummary]);

  const openRun = useCallback(async (id: string) => {
    if (!id) return;
    setDetailId(id);
    setActivePage("run");
    setDetailLoading(true);
    setDetailError(null);
    try {
      const payload = await getJson<{ run: HealResult | null; summary: RunSummary | null; events: AuditEvent[] }>(
        `/api/runs/${id}`,
      );
      setDetailRun(payload.run);
      setDetailSummary(payload.summary);
      setDetailEvents(payload.events);
    } catch (error) {
      setDetailError(error instanceof Error ? error.message : "Failed to load run");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (runState !== "running") void runHealer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runState, runHealer]);

  function reviewPatch() {
    setActivePage("incident");
    setTab("patch");
    document.getElementById("incident-workbench")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const openIncidentsCount = summaries.filter((run) => run.state !== "healed").length;

  return (
    <div className="app-shell">
      <Sidebar
        open={sidebarOpen}
        activePage={activePage}
        openIncidents={openIncidentsCount}
        systemOnline={online}
        onClose={() => setSidebarOpen(false)}
        onNavigate={setActivePage}
      />
      <div className="app-main">
        <Topbar page={activePage} onMenu={() => setSidebarOpen(true)} />
        <StatusRegion>
          {online ? "Service online." : "Service offline."} {runSummary ? `Run state: ${STATE_LABELS[runSummary.state]}.` : ""}
        </StatusRegion>
        <main className="content">
          {!online && activePage !== "run" ? (
            <div className="error-banner" role="alert">
              <AlertTriangle size={16} /> The TraceHealer service is unreachable. Start the server and retry.
            </div>
          ) : null}

          {authState ? <AuthGate state={authState} /> : null}

          {activePage === "run" ? (
            <RunDetail
              run={detailRun}
              summary={detailSummary}
              events={detailEvents}
              loading={detailLoading}
              error={detailError}
              onOpenRun={openRun}
            />
          ) : activePage === "incident" ? (
            <>
              <section className="incident-header">
                <div className="incident-title-row">
                  <div>
                    <div className="meta-row">
                      <span className="severity-pill"><span /> CRITICAL</span>
                      <span className="demo-flag">SEEDED DEMO TRACE</span>
                      <span>First seen {DEMO_INCIDENT.firstSeen}</span>
                      <span className="meta-dot" aria-hidden="true">·</span>
                      <span>{DEMO_INCIDENT.affectedRuns} affected runs</span>
                    </div>
                    <h1>{DEMO_INCIDENT.title}</h1>
                    <p>{DEMO_INCIDENT.summary}</p>
                  </div>
                  <div className="header-actions">
                    <a className="secondary-button" href="#trace"><ExternalLink size={15} /> Open trace</a>
                    <button className="primary-button" onClick={() => void runHealer()} disabled={runState === "running"}>
                      {runState === "complete" ? <><RotateCcw size={16} /> Run again</> : runState === "running" ? <><LoaderCircle className="spin" size={16} /> Healing…</> : <><Sparkles size={16} /> Heal incident</>}
                    </button>
                  </div>
                </div>
                <div className="context-bar">
                  <div><span>AGENT</span><strong><span className="mini-agent" aria-hidden="true"><Bot size={12} /></span> support-agent</strong></div>
                  <div><span>ENVIRONMENT</span><strong><span className="env-dot" aria-hidden="true" /> Production</strong></div>
                  <div><span>REPOSITORY</span><strong><GitHubIcon size={13} /> {DEMO_TRACE.repository}</strong></div>
                  <div><span>COMMIT</span><strong><GitBranch size={13} /> {DEMO_TRACE.commit}</strong></div>
                  <div><span>DETECTED BY</span><strong><span className="neatlogs-mark" aria-hidden="true">n</span> neatlogs</strong></div>
                </div>
              </section>

              <MetricsStrip metrics={metrics} loading={metricsLoading} />

              <section className="workbench" id="incident-workbench">
                <div className="workbench-main">
                  <div className="tabs" role="tablist" aria-label="Incident views">
                    <button role="tab" aria-selected={tab === "trace"} className={tab === "trace" ? "active" : ""} onClick={() => setTab("trace")}><Activity size={15} /> Trace</button>
                    <button role="tab" aria-selected={tab === "diagnosis"} className={tab === "diagnosis" ? "active" : ""} onClick={() => setTab("diagnosis")}><Bot size={15} /> Diagnosis {result ? <span>{Math.round(result.diagnosis.confidence * 100)}%</span> : null}</button>
                    <button role="tab" aria-selected={tab === "patch"} className={tab === "patch" ? "active" : ""} onClick={() => setTab("patch")}><Code2 size={15} /> Patch {result ? <span className="tab-ready">READY</span> : null}</button>
                  </div>
                  <div className="tab-content">
                    {tab === "trace" ? <TraceWaterfall selected={selectedSpan} onSelect={setSelectedSpan} /> : null}
                    {tab === "diagnosis" ? <DiagnosisView result={result} loading={runState === "running" && !result} /> : null}
                    {tab === "patch" ? <PatchView result={result} loading={runState === "running" && !result} onHeal={() => void runHealer()} canRun={runState !== "running"} /> : null}
                  </div>
                </div>
                <HealingAgent
                  state={runState}
                  activeStep={activeStep}
                  result={result}
                  error={runError}
                  canRun={runState !== "running"}
                  onRun={() => void runHealer()}
                  onReview={reviewPatch}
                  onCancel={() => void cancelRun()}
                />
              </section>

              {runEvents.length && runState === "running" ? (
                <section className="management-card live-timeline">
                  <span className="section-label">Live server progress</span>
                  <RunTimeline events={runEvents} summary={runSummary} />
                </section>
              ) : null}

              {result ? (
                <div id="verification"><ProofPanel result={result} onPublish={() => void publishRun()} publishing={publishing} publishMessage={publishMessage} /></div>
              ) : (
                <section className="pre-proof">
                  <div><ShieldCheck size={19} /><span><strong>Evidence, not promises.</strong> Every fix is replayed against the exact failed input before review.</span></div>
                  <div className="integration-chain">
                    <span><span className="neatlogs-mark" aria-hidden="true">n</span> neatlogs</span><i aria-hidden="true" />
                    <span><SquareTerminal size={14} /> TraceHealer</span><i aria-hidden="true" />
                    <span><GitHubIcon size={14} /> GitHub</span>
                  </div>
                </section>
              )}
            </>
          ) : (
            <ManagementPage
              page={activePage}
              metrics={metrics}
              metricsLoading={metricsLoading}
              integrations={integrations}
              summaries={summaries}
              runsLoading={runsLoading}
              runsError={runsError}
              onOpenIncident={() => setActivePage("incident")}
              onRunHealer={() => void runHealer()}
              canRun={runState !== "running"}
              healBusy={healBusy}
              onOpenRun={(id) => void openRun(id)}
            />
          )}

          <footer className="app-footer">
            <span><BrandMark className="footer-mark" /> TraceHealer · Built for neatHack</span>
            <span>Failure trace → root cause → verified patch</span>
          </footer>
        </main>
      </div>
      {detailId ? <span className="sr-only">Selected run {detailId}</span> : null}
    </div>
  );
}

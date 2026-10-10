"use client";

import {
  Activity,
  AlertTriangle,
  ArrowDown,
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
  MoreHorizontal,
  Radio,
  RotateCcw,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import { DEMO_INCIDENT, DEMO_TRACE } from "@/lib/demo-data";
import type { HealResult, TraceSpan } from "@/lib/types";

type Tab = "trace" | "diagnosis" | "patch";
type RunState = "idle" | "running" | "complete" | "error";
type Page = "incident" | "overview" | "incidents" | "runs" | "evaluations" | "repositories" | "integrations";

type IntegrationSnapshot = {
  github: { configured: boolean; autoPublish: boolean };
  neatlogs: { configured: boolean; signedWebhooks: boolean };
  slack: { configured: boolean };
  openai: { configured: boolean; model: string };
  entire: { configured: boolean };
  sandbox: { configured: boolean; provider: string };
};

const workflow = [
  { id: "capture", label: "Read failure trace", detail: "Import spans, inputs, and runtime context" },
  { id: "diagnose", label: "Isolate root cause", detail: "Map the stack frame to repository context" },
  { id: "patch", label: "Generate minimal patch", detail: "Change the smallest safe surface" },
  { id: "verify", label: "Replay & verify", detail: "Run the failed input and regression checks" },
  { id: "proposal", label: "Prepare review", detail: "Package evidence in a draft proposal" },
];

const spanWidths: Record<string, { left: number; width: number }> = {
  sp_root: { left: 0, width: 100 },
  sp_llm_1: { left: 2, width: 17 },
  sp_tool: { left: 20, width: 8 },
  sp_parse: { left: 29, width: 4 },
  sp_retry: { left: 32, width: 67 },
};

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

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

function Sidebar({
  open,
  activePage,
  onClose,
  onNavigate,
}: {
  open: boolean;
  activePage: Page;
  onClose: () => void;
  onNavigate: (page: Page) => void;
}) {
  const nav: Array<{ icon: typeof LayoutDashboard; label: string; page: Page; count?: number }> = [
    { icon: LayoutDashboard, label: "Overview", page: "overview" },
    { icon: AlertTriangle, label: "Incidents", page: "incidents", count: 1 },
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
          <span className="mobile-close" onClick={(event) => { event.stopPropagation(); onClose(); }} aria-label="Close menu" role="button">
            <X size={18} />
          </span>
        </button>

        <button className="workspace-switcher">
          <span className="workspace-avatar">N</span>
          <span>
            <strong>NeatHack Lab</strong>
            <small>Production workspace</small>
          </span>
          <ChevronDown size={14} />
        </button>

        <nav className="side-nav" aria-label="Primary navigation">
          <p className="nav-label">MONITOR</p>
          {nav.map((item) => (
            <button
              className={`nav-item ${activePage === item.page || (item.page === "incidents" && activePage === "incident") ? "active" : ""}`}
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
            <span className="connected-dot" />
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="system-status">
            <span className="status-orbit"><span /></span>
            <div>
              <strong>All systems operational</strong>
              <small>Watching 3 agents</small>
            </div>
          </div>
          <div className="user-row">
            <div className="user-avatar">S</div>
            <div>
              <strong>Sumit</strong>
              <small>Builder plan</small>
            </div>
            <MoreHorizontal size={17} />
          </div>
        </div>
      </aside>
    </>
  );
}

function Topbar({ page, onMenu }: { page: Page; onMenu: () => void }) {
  const labels: Record<Page, string> = {
    incident: "INC-2841",
    overview: "Overview",
    incidents: "Incidents",
    runs: "Healing runs",
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
        <span>/</span>
        <strong>{labels[page]}</strong>
      </div>
      <div className="topbar-actions">
        <div className="command-search">
          <Search size={15} />
          <span>Search traces, runs...</span>
          <kbd>⌘ K</kbd>
        </div>
        <div className="live-pill"><span /> LIVE</div>
        <button className="icon-button" aria-label="Notifications">
          <Bell size={17} />
          <span className="notification-dot" />
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
          <span className="eyebrow">TRACE</span>
          <strong>{DEMO_TRACE.id}</strong>
        </div>
        <div className="trace-summary">
          <span><Clock3 size={13} /> 6.84s</span>
          <span><Zap size={13} /> 4,280 tokens</span>
          <span><CircleDollarSign size={13} /> $0.0284</span>
          <button aria-label="More trace options"><MoreHorizontal size={16} /></button>
        </div>
      </div>
      <div className="waterfall-head">
        <span>Span</span>
        <div className="ticks"><span>0s</span><span>2s</span><span>4s</span><span>6.8s</span></div>
      </div>
      <div className="waterfall-list">
        {DEMO_TRACE.spans.map((span, index) => (
          <SpanRow
            key={span.id}
            span={span}
            depth={span.parentId ? 1 : 0}
            selected={selected === span.id}
            onSelect={() => onSelect(span.id)}
            index={index}
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
  index,
}: {
  span: TraceSpan;
  depth: number;
  selected: boolean;
  onSelect: () => void;
  index: number;
}) {
  const bar = spanWidths[span.id] ?? { left: index * 5, width: 20 };
  return (
    <button className={`span-row ${selected ? "selected" : ""}`} onClick={onSelect}>
      <span className="span-name" style={{ paddingLeft: `${14 + depth * 17}px` }}>
        {depth ? <span className="tree-elbow">└</span> : null}
        <span className={`span-status ${span.status}`} />
        <span>{span.name}</span>
        {span.status === "error" ? <AlertTriangle size={12} /> : null}
      </span>
      <span className="span-lane">
        <span
          className={`span-bar ${span.status}`}
          style={{ left: `${bar.left}%`, width: `${Math.max(bar.width, 3)}%` }}
        >
          {bar.width > 13 ? <small>{formatDuration(span.durationMs)}</small> : null}
        </span>
      </span>
      <span className="span-time">{formatDuration(span.durationMs)}</span>
    </button>
  );
}

function SpanInspector({ span }: { span: TraceSpan }) {
  const isError = span.status === "error";
  return (
    <div className="span-inspector">
      <div className="inspector-head">
        <div>
          <span className={`span-status ${span.status}`} />
          <strong>{span.name}</strong>
          <span className="service-badge">{span.service}</span>
        </div>
        <button aria-label="Copy span id"><Copy size={13} /> {span.id}</button>
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

function DiagnosisView({ result }: { result: HealResult | null }) {
  const diagnosis = result?.diagnosis;
  return (
    <div className="diagnosis-view">
      <div className="confidence-card">
        <div className="confidence-ring"><span>{diagnosis ? Math.round(diagnosis.confidence * 100) : 96}%</span></div>
        <div>
          <span className="eyebrow">ROOT CAUSE CONFIDENCE</span>
          <h3>{diagnosis?.summary ?? "Upstream response drift bypassed the agent's contract guard"}</h3>
          <p>
            {diagnosis?.rootCause ??
              "Order API v3 returns contact.primaryEmail, while the agent still dereferences customer.email. The undefined property throws before the agent can answer."}
          </p>
        </div>
      </div>
      <div className="evidence-grid">
        <div className="evidence-block">
          <span className="section-label">Evidence chain</span>
          {(diagnosis?.evidence ?? [
            "order.normalize raised a property access TypeError",
            "Top frame: src/agents/order-support.ts:47",
            "lookup_order returned HTTP 200 with api.version v3",
            "Retry loop consumed 3,358 unnecessary tokens",
          ]).map((item, index) => (
            <div className="evidence-row" key={item}>
              <span>{index + 1}</span><p>{item}</p>
            </div>
          ))}
        </div>
        <div className="contract-change">
          <span className="section-label">Detected contract change</span>
          <div className="contract-code">
            <div><span className="minus">−</span><code>order.customer.email</code></div>
            <ArrowDown size={14} />
            <div><span className="plus">+</span><code>order.contact.primaryEmail</code></div>
          </div>
          <div className="source-chip">
            <FileCode2 size={14} /> {diagnosis?.file ?? "src/order-support.mjs"}
            <span>Line {diagnosis?.line ?? 9}</span>
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
      <span className="diff-marker">{kind === "plain" ? " " : marker}</span>
      <code>{kind === "plain" ? line : line.slice(1)}</code>
    </div>
  );
}

function PatchView({ result, onHeal }: { result: HealResult | null; onHeal: () => void }) {
  if (!result) {
    return (
      <div className="empty-patch">
        <div className="empty-patch-icon"><Code2 size={24} /></div>
        <h3>No patch generated yet</h3>
        <p>Run TraceHealer to diagnose this failure, generate the smallest safe fix, and replay the exact input.</p>
        <button className="primary-button compact" onClick={onHeal}><Sparkles size={15} /> Heal this incident</button>
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
        {result.patch.diff.split("\n").map((line, index) => <DiffLine line={line} key={`${line}-${index}`} />)}
      </div>
    </div>
  );
}

function HealingAgent({
  state,
  activeStep,
  result,
  error,
  onRun,
  onReview,
}: {
  state: RunState;
  activeStep: number;
  result: HealResult | null;
  error: string | null;
  onRun: () => void;
  onReview: () => void;
}) {
  return (
    <aside className={`healer-card ${state}`}>
      <div className="healer-glow" />
      <div className="healer-head">
        <div className="agent-avatar"><Bot size={19} /></div>
        <div>
          <span className="eyebrow">AUTONOMOUS HEALER</span>
          <strong>{state === "complete" ? "Incident contained" : state === "running" ? "Healing in progress" : "Ready to investigate"}</strong>
        </div>
        {state === "running" ? <LoaderCircle className="spin" size={18} /> : state === "complete" ? <CheckCircle2 className="success-icon" size={19} /> : <Radio size={18} />}
      </div>

      <div className="workflow">
        {workflow.map((step, index) => {
          const complete = state === "complete" || index < activeStep;
          const active = state === "running" && index === activeStep;
          return (
            <div className={`workflow-step ${complete ? "step-complete" : ""} ${active ? "step-active" : ""}`} key={step.id}>
              <div className="workflow-rail">
                <span>{complete ? <Check size={12} strokeWidth={3} /> : active ? <LoaderCircle className="spin" size={12} /> : index + 1}</span>
                {index < workflow.length - 1 ? <i /> : null}
              </div>
              <div>
                <strong>{result?.steps[index]?.label ?? step.label}</strong>
                <p>{complete && result ? result.steps[index].detail : step.detail}</p>
              </div>
              {complete && result ? <small>{result.steps[index].durationMs < 1000 ? `${result.steps[index].durationMs}ms` : `${(result.steps[index].durationMs / 1000).toFixed(1)}s`}</small> : null}
            </div>
          );
        })}
      </div>

      {error ? <div className="run-error"><AlertTriangle size={15} /> {error}</div> : null}

      {state === "complete" && result ? (
        <div className="healed-summary">
          <div className="healed-check"><Check size={18} strokeWidth={3} /></div>
          <div>
            <strong>Verified in an isolated workspace</strong>
            <span>
              {result.verification.checks.filter((check) => check.status === "passed").length}/{result.verification.checks.length} checks passed
              {result.artifacts?.localCommit ? ` · commit ${result.artifacts.localCommit}` : ""}
            </span>
          </div>
        </div>
      ) : null}

      <button
        className={`agent-button ${state === "complete" ? "review" : ""}`}
        disabled={state === "running"}
        onClick={state === "complete" ? onReview : onRun}
      >
        {state === "running" ? <><LoaderCircle className="spin" size={16} /> Running healer...</> : state === "complete" ? <><GitBranch size={16} /> Review proposed patch <ArrowUpRight size={15} /></> : <><Sparkles size={16} /> Heal this incident</>}
      </button>
      <p className="agent-footnote"><ShieldCheck size={12} /> Review required · TraceHealer never merges automatically</p>
    </aside>
  );
}

function ProofPanel({ result }: { result: HealResult }) {
  const metrics = [
    { label: "Latency", before: formatDuration(result.verification.before.durationMs), after: formatDuration(result.verification.after.durationMs), percent: result.verification.improvements.latencyPercent },
    { label: "Tokens", before: result.verification.before.tokens.toLocaleString(), after: result.verification.after.tokens.toLocaleString(), percent: result.verification.improvements.tokenPercent },
    { label: "Cost / run", before: formatMoney(result.verification.before.costUsd), after: formatMoney(result.verification.after.costUsd), percent: result.verification.improvements.costPercent },
  ];
  return (
    <section className="proof-section">
      <div className="proof-heading">
        <div className="proof-icon"><ShieldCheck size={19} /></div>
        <div><span className="eyebrow">VERIFICATION REPORT</span><h2>Same input. Measurably better run.</h2></div>
        <span className="passed-pill"><Check size={13} /> ALL CHECKS PASSED</span>
      </div>
      <div className="proof-grid">
        {metrics.map((metric) => (
          <div className="proof-metric" key={metric.label}>
            <span>{metric.label}</span>
            <div><s>{metric.before}</s><ArrowDown size={14} /><strong>{metric.after}</strong></div>
            <small>↓ {metric.percent}%</small>
          </div>
        ))}
        <div className="proof-metric success-metric">
          <span>Trace status</span>
          <div><s>FAILED</s><ArrowDown size={14} /><strong>HEALTHY</strong></div>
          <small><Check size={12} /> 0 errors</small>
        </div>
      </div>
      <div className="test-strip">
        {result.verification.checks.map((check) => (
          <div key={check.name}><CheckCircle2 size={14} /><span>{check.name}</span><small>{check.durationMs}ms</small></div>
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
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ValueStrip() {
  const values = [
    { label: "Traces watched", value: "12,481", detail: "this month", icon: Activity },
    { label: "Auto-diagnosed", value: "94.2%", detail: "+3.4%", icon: Bot },
    { label: "Engineer time saved", value: "46.5h", detail: "≈ $5,580", icon: Clock3 },
    { label: "Mean time to patch", value: "4.8s", detail: "↓ 81%", icon: Zap },
  ];
  return (
    <section className="value-strip">
      {values.map((item) => (
        <div className="value-item" key={item.label}>
          <div className="value-icon"><item.icon size={16} /></div>
          <div><span>{item.label}</span><strong>{item.value}</strong></div>
          <small>{item.detail}</small>
        </div>
      ))}
    </section>
  );
}

function ManagementPage({
  page,
  latestResult,
  onOpenIncident,
  onRunHealer,
}: {
  page: Exclude<Page, "incident">;
  latestResult: HealResult | null;
  onOpenIncident: () => void;
  onRunHealer: () => void;
}) {
  const [runs, setRuns] = useState<HealResult[]>(latestResult ? [latestResult] : []);
  const [integrations, setIntegrations] = useState<IntegrationSnapshot | null>(null);

  useEffect(() => {
    let current = true;
    if (page === "runs" || page === "overview") {
      void fetch("/api/runs?limit=10")
        .then((response) => response.json())
        .then((payload: { runs?: HealResult[] }) => { if (current && payload.runs) setRuns(payload.runs); })
        .catch(() => undefined);
    }
    if (page === "integrations" || page === "overview" || page === "repositories") {
      void fetch("/api/integrations")
        .then((response) => response.json())
        .then((payload: { integrations?: IntegrationSnapshot }) => { if (current && payload.integrations) setIntegrations(payload.integrations); })
        .catch(() => undefined);
    }
    return () => { current = false; };
  }, [page, latestResult]);

  const pageMeta: Record<Exclude<Page, "incident">, { eyebrow: string; title: string; description: string }> = {
    overview: { eyebrow: "CONTROL CENTER", title: "Agent reliability at a glance", description: "Monitor failures, verified repairs, and every integration in the healing path." },
    incidents: { eyebrow: "INCIDENT QUEUE", title: "Production incidents", description: "Prioritized failures grouped by root-cause fingerprint and customer impact." },
    runs: { eyebrow: "AUDIT LOG", title: "Healing runs", description: "Every diagnosis, sandbox replay, patch artifact, and delivery attempt." },
    evaluations: { eyebrow: "QUALITY GATES", title: "Verification policies", description: "Deterministic checks that every generated patch must pass before publication." },
    repositories: { eyebrow: "SOURCE CONTROL", title: "Repositories", description: "Manage source context, base branches, test commands, and publication policy." },
    integrations: { eyebrow: "CONNECTED SYSTEMS", title: "Integrations", description: "Trace intake, repository delivery, context providers, models, and notifications." },
  };
  const meta = pageMeta[page];

  const heading = (
    <div className="management-heading">
      <div><span className="eyebrow">{meta.eyebrow}</span><h1>{meta.title}</h1><p>{meta.description}</p></div>
      {page === "overview" || page === "incidents" ? (
        <button className="primary-button" onClick={onRunHealer}><Sparkles size={15} /> Run full pipeline</button>
      ) : null}
    </div>
  );

  if (page === "overview") {
    return (
      <section className="management-page">
        {heading}
        <ValueStrip />
        <div className="overview-grid">
          <div className="management-card incident-spotlight">
            <div className="card-topline"><span className="severity-pill"><span /> CRITICAL</span><small>18 minutes ago</small></div>
            <h2>Order support agent is failing</h2>
            <p>Order API v3 moved the customer email field. Thirty-seven runs entered the same retry loop.</p>
            <div className="mini-trace"><i className="ok" /><i className="ok" /><i className="error" /><i className="error long" /></div>
            <button className="text-action" onClick={onOpenIncident}>Open incident <ArrowUpRight size={14} /></button>
          </div>
          <div className="management-card pipeline-card">
            <div className="card-title"><span><Activity size={15} /> Healing pipeline</span><small className="healthy-label"><span /> OPERATIONAL</small></div>
            <div className="pipeline-map">
              {["Trace", "Context", "Patch", "Sandbox", "Review"].map((label, index) => (
                <div key={label}><span>{index + 1}</span><strong>{label}</strong>{index < 4 ? <i /> : null}</div>
              ))}
            </div>
            <p>The local deterministic pipeline is ready. External delivery activates automatically when credentials are configured.</p>
          </div>
          <div className="management-card recent-runs-card">
            <div className="card-title"><span><HeartPulse size={15} /> Recent runs</span><button className="text-action">View all</button></div>
            {(runs.length ? runs.slice(0, 3) : latestResult ? [latestResult] : []).map((run) => (
              <div className="compact-run" key={run.id}>
                <span className={`run-state ${run.status}`}><Check size={11} /></span>
                <div><strong>{run.diagnosis.summary}</strong><small>{run.id} · {run.artifacts?.localCommit ?? "analysis only"}</small></div>
                <span>{run.verification.checks.filter((check) => check.status === "passed").length}/{run.verification.checks.length}</span>
              </div>
            ))}
            {!runs.length && !latestResult ? <div className="empty-row">Run the incident pipeline to create the first audit record.</div> : null}
          </div>
          <div className="management-card readiness-card">
            <div className="card-title"><span><ShieldCheck size={15} /> Delivery readiness</span></div>
            <div className="readiness-list">
              <div><span><SquareTerminal size={14} /> Local sandbox</span><strong className="ready">READY</strong></div>
              <div><span><GitHubIcon size={14} /> GitHub drafts</span><strong className={integrations?.github.configured ? "ready" : "optional"}>{integrations?.github.configured ? "READY" : "CONFIGURE"}</strong></div>
              <div><span><Radio size={14} /> neatlogs export</span><strong className={integrations?.neatlogs.configured ? "ready" : "optional"}>{integrations?.neatlogs.configured ? "READY" : "CONFIGURE"}</strong></div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (page === "incidents") {
    return (
      <section className="management-page">
        {heading}
        <div className="filter-row"><button className="filter-active">Open <span>1</span></button><button>Healed <span>{latestResult ? 1 : 0}</span></button><button>All</button><div><Search size={14} /> Filter incidents</div></div>
        <div className="data-table incident-table">
          <div className="table-head"><span>Incident</span><span>Agent</span><span>Impact</span><span>First seen</span><span>Status</span><span /></div>
          <button className="table-row" onClick={onOpenIncident}>
            <span><span className="table-severity" /><span><strong>Order support agent is failing</strong><small>Schema drift · customer.email</small></span></span>
            <span><Bot size={14} /> support-agent</span><span>37 runs</span><span>18m ago</span>
            <span><span className={`status-chip ${latestResult ? "healed" : "open"}`}>{latestResult ? "HEALED" : "OPEN"}</span></span>
            <span><ArrowUpRight size={14} /></span>
          </button>
        </div>
      </section>
    );
  }

  if (page === "runs") {
    return (
      <section className="management-page">
        {heading}
        <div className="data-table runs-table">
          <div className="table-head"><span>Run</span><span>Root cause</span><span>Verification</span><span>Commit</span><span>Started</span></div>
          {runs.map((run) => (
            <div className="table-row" key={run.id}>
              <span><span className={`run-state ${run.status}`}><Check size={11} /></span><span><strong>{run.id}</strong><small>{run.mode}</small></span></span>
              <span>{run.diagnosis.category}</span>
              <span><span className="status-chip healed">{run.verification.checks.filter((check) => check.status === "passed").length}/{run.verification.checks.length} PASSED</span></span>
              <span><code>{run.artifacts?.localCommit ?? "—"}</code></span>
              <span>{new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>
          ))}
          {!runs.length ? <div className="empty-row">No persisted healing runs yet.</div> : null}
        </div>
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
      ["Minimal scope", "Keep the generated change to the localized source file."],
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
          <div><h3>northstar/support-agent</h3><p>Demo target · JavaScript · main</p></div>
          <span className="status-chip healed">CONNECTED</span>
          <button className="secondary-button" onClick={onOpenIncident}>Open incident</button>
        </div>
        <div className="repository-grid">
          <div className="management-card"><span className="section-label">Execution policy</span><dl><div><dt>Test command</dt><dd><code>node --test</code></dd></div><div><dt>Workspace</dt><dd>Ephemeral copy</dd></div><div><dt>Timeout</dt><dd>20 seconds</dd></div><div><dt>Network</dt><dd>Disabled by strategy</dd></div></dl></div>
          <div className="management-card"><span className="section-label">Publication policy</span><dl><div><dt>Target</dt><dd>Draft pull request</dd></div><div><dt>Auto merge</dt><dd>Never</dd></div><div><dt>Human review</dt><dd>Required</dd></div><div><dt>Automatic drafts</dt><dd>{integrations?.github.autoPublish ? "Enabled" : "Disabled"}</dd></div></dl></div>
        </div>
      </section>
    );
  }

  const integrationCards = [
    { name: "neatlogs", detail: "Failed-trace intake and verified after-trace export", configured: integrations?.neatlogs.configured, icon: Radio },
    { name: "GitHub", detail: "Source delivery through review-only draft pull requests", configured: integrations?.github.configured, icon: GitBranch },
    { name: "Local sandbox", detail: "Failure reproduction, test execution, and local commits", configured: true, icon: SquareTerminal },
    { name: "Entire", detail: "Optional repository graph and checkpoint context provider", configured: integrations?.entire.configured, icon: Activity },
    { name: "OpenAI", detail: `Optional generic patch strategy · ${integrations?.openai.model ?? "gpt-5-mini"}`, configured: integrations?.openai.configured, icon: Bot },
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

export function TraceHealerApp() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activePage, setActivePage] = useState<Page>("incident");
  const [tab, setTab] = useState<Tab>("trace");
  const [selectedSpan, setSelectedSpan] = useState("sp_parse");
  const [runState, setRunState] = useState<RunState>("idle");
  const [activeStep, setActiveStep] = useState(-1);
  const [result, setResult] = useState<HealResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const tabCount = useMemo(() => (result ? 1 : 0), [result]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (runState !== "running") void runHealer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runState]);

  async function runHealer() {
    setActivePage("incident");
    setRunState("running");
    setRunError(null);
    setResult(null);
    setActiveStep(0);

    try {
      const responsePromise = fetch("/api/heal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "demo" }),
      });

      for (let step = 0; step < workflow.length; step += 1) {
        setActiveStep(step);
        await wait(step === 0 ? 380 : step === 1 ? 620 : step === 2 ? 700 : 540);
      }

      const response = await responsePromise;
      const payload = (await response.json()) as { ok: boolean; result?: HealResult; error?: string };
      if (!response.ok || !payload.result) throw new Error(payload.error ?? "The healer did not return a result");

      setResult(payload.result);
      setActiveStep(workflow.length);
      setRunState("complete");
      await wait(220);
      document.getElementById("verification")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      setRunError(error instanceof Error ? error.message : "Healing run failed");
      setRunState("error");
      setActiveStep(-1);
    }
  }

  function reviewPatch() {
    setActivePage("incident");
    setTab("patch");
    document.getElementById("incident-workbench")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="app-shell">
      <Sidebar
        open={sidebarOpen}
        activePage={activePage}
        onClose={() => setSidebarOpen(false)}
        onNavigate={setActivePage}
      />
      <div className="app-main">
        <Topbar page={activePage} onMenu={() => setSidebarOpen(true)} />
        <main className="content">
          {activePage === "incident" ? <>
          <section className="incident-header">
            <div className="incident-title-row">
              <div>
                <div className="meta-row">
                  <span className="severity-pill"><span /> CRITICAL</span>
                  <span>First seen {DEMO_INCIDENT.firstSeen}</span>
                  <span className="meta-dot">·</span>
                  <span>37 affected runs</span>
                </div>
                <h1>{DEMO_INCIDENT.title}</h1>
                <p>{DEMO_INCIDENT.summary}</p>
              </div>
              <div className="header-actions">
                <a className="secondary-button" href="#trace"><ExternalLink size={15} /> Open trace</a>
                <button className="primary-button" onClick={() => void runHealer()} disabled={runState === "running"}>
                  {runState === "complete" ? <><RotateCcw size={16} /> Run again</> : runState === "running" ? <><LoaderCircle className="spin" size={16} /> Healing...</> : <><Sparkles size={16} /> Heal incident</>}
                </button>
              </div>
            </div>
            <div className="context-bar">
              <div><span>AGENT</span><strong><span className="mini-agent"><Bot size={12} /></span> support-agent</strong></div>
              <div><span>ENVIRONMENT</span><strong><span className="env-dot" /> Production</strong></div>
              <div><span>REPOSITORY</span><strong><GitHubIcon size={13} /> northstar/support-agent</strong></div>
              <div><span>COMMIT</span><strong><GitBranch size={13} /> 8d2f19c</strong></div>
              <div><span>DETECTED BY</span><strong><span className="neatlogs-mark">n</span> neatlogs</strong></div>
            </div>
          </section>

          <ValueStrip />

          <section className="workbench" id="incident-workbench">
            <div className="workbench-main">
              <div className="tabs">
                <button className={tab === "trace" ? "active" : ""} onClick={() => setTab("trace")}><Activity size={15} /> Trace</button>
                <button className={tab === "diagnosis" ? "active" : ""} onClick={() => setTab("diagnosis")}><Bot size={15} /> Diagnosis <span>96%</span></button>
                <button className={tab === "patch" ? "active" : ""} onClick={() => setTab("patch")}><Code2 size={15} /> Patch {tabCount ? <span className="tab-ready">READY</span> : null}</button>
              </div>
              <div className="tab-content">
                {tab === "trace" ? <TraceWaterfall selected={selectedSpan} onSelect={setSelectedSpan} /> : null}
                {tab === "diagnosis" ? <DiagnosisView result={result} /> : null}
                {tab === "patch" ? <PatchView result={result} onHeal={() => void runHealer()} /> : null}
              </div>
            </div>
            <HealingAgent
              state={runState}
              activeStep={activeStep}
              result={result}
              error={runError}
              onRun={() => void runHealer()}
              onReview={reviewPatch}
            />
          </section>

          {result ? <div id="verification"><ProofPanel result={result} /></div> : (
            <section className="pre-proof">
              <div><ShieldCheck size={19} /><span><strong>Evidence, not promises.</strong> Every fix is replayed against the exact failed input before review.</span></div>
              <div className="integration-chain">
                <span><span className="neatlogs-mark">n</span> neatlogs</span><i />
                <span><SquareTerminal size={14} /> TraceHealer</span><i />
                <span><GitHubIcon size={14} /> GitHub</span>
              </div>
            </section>
          )}
          </> : (
            <ManagementPage
              page={activePage}
              latestResult={result}
              onOpenIncident={() => setActivePage("incident")}
              onRunHealer={() => void runHealer()}
            />
          )}

          <footer className="app-footer">
            <span><BrandMark className="footer-mark" /> TraceHealer · Built for neatHack</span>
            <span>Failure trace → root cause → verified patch</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

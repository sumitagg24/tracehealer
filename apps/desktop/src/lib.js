// Pure renderer logic for the TraceHealer desktop window.
//
// Everything in this module is deterministic and side-effect free, so it can be
// tested with `node --test` without a browser or a Tauri process. The DOM layer
// in app.js does nothing but call these functions and draw the result with
// textContent — which is also why no function here returns HTML.

/** Run states that end a run; the shell notifies on exactly these. */
export const TERMINAL_STATES = Object.freeze([
  "healed",
  "needs-review",
  "cancelled",
  "timed-out",
  "delivery-failed",
]);

export function isTerminalState(state) {
  return TERMINAL_STATES.includes(state);
}

/** How a run summary maps onto the three UI phases. */
export function classifyRunProgress(summary) {
  if (!summary || typeof summary.state !== "string") return "loading";
  return isTerminalState(summary.state) ? "terminal" : "running";
}

/** Bounded exponential backoff for reconnect attempts. */
export function backoffMs(attempt, base = 700, cap = 15_000) {
  return Math.min(base * 2 ** Math.max(0, attempt - 1), cap);
}

/** Authentication meaning of a status code, given what we knew before. */
export function authState(status, hadSession) {
  if (status === 401) return hadSession ? "expired" : "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 0) return "offline";
  return null;
}

/**
 * The wire value for the shell's `ConnectionState`.
 * `Connected` carries the server address because the shell learns it that way.
 */
export function connectionStateFor(status, hadSession, serverUrl = "") {
  if (status >= 200 && status < 300) {
    return serverUrl ? { Connected: { server_url: serverUrl } } : "Offline";
  }
  if (status === 401) return hadSession ? "Expired" : "Unauthorized";
  if (status === 403) return "Forbidden";
  return "ServerUnavailable";
}

/** Only `tracehealer://incident/:id` and `tracehealer://run/:id` are honoured. */
export function deepLinkTarget(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.includes("..")) return null;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "tracehealer:") return null;
  const kind = url.host;
  const id = url.pathname.replace(/^\//, "").split("/")[0];
  if (kind !== "incident" && kind !== "run") return null;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  return { kind, id };
}

/** Update policy: unsigned or unpinned metadata never installs itself. */
export function updateDecision({ signed, trustedKey, pinnedChannel }) {
  if (!signed || !trustedKey) return "refuse-unsigned";
  if (!pinnedChannel) return "refuse-unknown-channel";
  return "install-with-notice";
}

/**
 * Render one shell error for display.
 *
 * The shell sends a fixed public shape and nothing else, so this only ever
 * reads `code` and `message`: a stray field cannot smuggle a path or a token
 * onto the screen.
 */
export function formatPublicError(error) {
  if (!error || typeof error !== "object") return "The desktop client reported an unknown failure.";
  const message = typeof error.message === "string" && error.message ? error.message : "The desktop client rejected that action.";
  const code = typeof error.code === "string" && error.code ? ` (${error.code})` : "";
  return `${message}${code}`;
}

/** The deep link a run notification points at (mirrors the shell's rule). */
export function notificationTargetFor(runId) {
  if (typeof runId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(runId)) return null;
  return `tracehealer://run/${runId}`;
}

/** Notification outcome, phrased for a person. */
export function notificationLabel(outcome) {
  const reason = outcome && typeof outcome.reason === "string" ? outcome.reason : "unknown";
  switch (reason) {
    case "sent":
      return "Notification sent";
    case "disabled":
      return "Notifications are turned off";
    case "not-terminal":
      return "The run has not finished yet";
    case "duplicate":
      return "Already announced for this run";
    case "delivery-failed":
      return "The notification service refused the request";
    case "invalid-run-id":
      return "That run identifier is not valid";
    default:
      return "No notification was sent";
  }
}

function asArray(value, cap) {
  return Array.isArray(value) ? value.slice(0, cap) : [];
}

function text(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

/** Run list projection. */
export function mapRuns(payload) {
  return asArray(payload && payload.runs, 100).map((run) => ({
    id: text(run?.id),
    state: text(run?.state, "unknown"),
    status: text(run?.status),
    mode: text(run?.mode),
    traceId: text(run?.traceId),
    startedAt: text(run?.startedAt),
    completedAt: run?.completedAt ? text(run.completedAt) : null,
    hasResult: Boolean(run?.hasResult),
  }));
}

/** Incident list projection. */
export function mapIncidents(payload) {
  return asArray(payload && payload.incidents, 50).map((incident) => ({
    id: text(incident?.id),
    title: text(incident?.title, text(incident?.summary, "Untitled incident")),
    service: text(incident?.service),
    severity: text(incident?.severity),
    status: text(incident?.status, "unknown"),
    latestHealingRunId: incident?.latestHealingRunId ? text(incident.latestHealingRunId) : null,
  }));
}

/** Progress projection: state, audit trail, and the finished result if any. */
export function mapRunProgress(payload) {
  const summary = payload && typeof payload.summary === "object" ? payload.summary : null;
  return {
    state: text(summary?.state, "unknown"),
    traceId: text(summary?.traceId),
    startedAt: text(summary?.startedAt),
    completedAt: summary?.completedAt ? text(summary.completedAt) : null,
    events: asArray(payload && payload.events, 200).map((event) => ({
      seq: Number.isFinite(event?.seq) ? event.seq : 0,
      at: text(event?.at),
      state: text(event?.state, "unknown"),
      message: text(event?.message),
    })),
    result: payload && typeof payload.result === "object" ? payload.result : null,
  };
}

/** What one queued shell event means for the UI. */
export function interpretEvent(event) {
  const kind = text(event?.kind);
  const payload = event?.payload;
  switch (kind) {
    case "open-target":
      return { action: "open", target: { kind: text(payload?.kind), id: text(payload?.id) } };
    case "auth-callback":
      return { action: "session-changed", session: payload?.session ?? null };
    case "auth-error":
    case "deep-link-rejected":
      return { action: "error", error: payload };
    case "connection-state":
      return { action: "connection", state: payload ?? "Offline" };
    case "navigate":
      return { action: "navigate", channel: text(payload?.channel, "/") };
    case "notifications-changed":
      return { action: "notifications", allowed: Boolean(payload?.allowed) };
    case "run-update":
      return {
        action: "run-update",
        runId: text(payload?.runId),
        state: text(payload?.state),
        notified: Boolean(payload?.notified),
      };
    default:
      return { action: "ignore" };
  }
}

/**
 * Follow a run until it reaches a terminal state.
 *
 * Progress is real server state — nothing here advances a timer or invents a
 * phase. A healthy read resets the backoff, a failure backs off, an
 * unauthenticated or missing run stops the loop, and the whole thing gives up
 * at `deadlineMs` so a broken server cannot keep the window busy forever.
 */
export async function pollRunProgress({
  runId,
  request,
  sleep,
  onUpdate = () => {},
  onFailure = () => {},
  onTerminal = () => {},
  shouldStop = () => false,
  maxAttempts = 600,
  deadlineMs = 10 * 60 * 1000,
  now = () => Date.now(),
  delay = backoffMs,
}) {
  const started = now();
  let failures = 0;
  let reads = 0;

  while (reads < maxAttempts) {
    if (shouldStop()) return { status: "stopped", reads };
    reads += 1;
    let response;
    try {
      response = await request("GET", `/api/runs/${encodeURIComponent(runId)}/progress`);
    } catch (error) {
      failures += 1;
      onFailure({ kind: "transport", error });
      if (now() - started > deadlineMs) return { status: "exhausted", reads };
      await sleep(delay(failures));
      continue;
    }

    if (response.status === 200) {
      const progress = mapRunProgress(response.body);
      failures = 0;
      onUpdate(progress);
      if (isTerminalState(progress.state)) {
        onTerminal(progress);
        return { status: "terminal", reads, progress };
      }
    } else if (response.status === 401 || response.status === 403) {
      onFailure({ kind: authState(response.status, true), status: response.status });
      return { status: "unauthorized", reads };
    } else if (response.status === 404) {
      onFailure({ kind: "not-found", status: 404 });
      return { status: "not-found", reads };
    } else {
      failures += 1;
      onFailure({ kind: "server", status: response.status });
    }

    if (now() - started > deadlineMs) return { status: "exhausted", reads };
    await sleep(delay(failures));
  }

  return { status: "exhausted", reads };
}

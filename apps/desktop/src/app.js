// The desktop window.
//
// The window holds no credentials and no policy: it calls the shell for every
// action, renders whatever comes back with textContent, and never writes to web
// storage. Anything it needs to remember lives in the shell's own state.

import { bridgeAvailable, invoke, takeEvents } from "./bridge.js";
import {
  connectionStateFor,
  formatPublicError,
  interpretEvent,
  mapIncidents,
  mapRuns,
  mapRunProgress,
  notificationLabel,
  pollRunProgress,
} from "./lib.js";

const byId = (id) => document.getElementById(id);

const elements = {
  banner: byId("banner"),
  status: byId("status"),
  serverInput: byId("server-url"),
  saveServer: byId("save-server"),
  signIn: byId("sign-in"),
  signOut: byId("sign-out"),
  notifyToggle: byId("notify-toggle"),
  refresh: byId("refresh"),
  incidentList: byId("incident-list"),
  runList: byId("run-list"),
  detailTitle: byId("run-title"),
  detailState: byId("run-state"),
  detailBody: byId("run-detail"),
  eventLog: byId("event-log"),
  readiness: byId("readiness"),
  notifyState: byId("notify-state"),
};

const state = {
  settings: null,
  incidents: [],
  runs: [],
  selectedRunId: null,
  pollGeneration: 0,
};

function describe(error) {
  // Shell errors arrive as the shell's fixed public shape; local failures are
  // ordinary Error instances.
  return error instanceof Error ? error.message : formatPublicError(error);
}

function banner(message, tone = "info") {
  elements.banner.textContent = message;
  elements.banner.dataset.tone = tone;
}

function setText(node, value) {
  node.textContent = value;
}

function renderStatus(label, tone) {
  setText(elements.status, label);
  elements.status.dataset.tone = tone;
}

// ---------------------------------------------------------------------------
// Shell interaction
// ---------------------------------------------------------------------------

async function refreshSettings() {
  const view = await invoke("get_settings");
  state.settings = view;
  renderSettings();
  return view;
}

function renderSettings() {
  const view = state.settings;
  if (!view) return;
  if (document.activeElement !== elements.serverInput) {
    elements.serverInput.value = view.server_url ?? "";
  }
  elements.notifyToggle.checked = Boolean(view.notifications_allowed);
  setText(
    elements.notifyState,
    view.notifications_allowed ? "Native notifications are on." : "Native notifications are off.",
  );
  if (view.signed_in) {
    setText(
      elements.signIn,
      `Signed in as ${view.role || "operator"} · ${view.workspace_id || "workspace"}`,
    );
    elements.signIn.dataset.state = "signed-in";
  } else {
    setText(elements.signIn, "Sign in");
    elements.signIn.dataset.state = "signed-out";
  }
  if (view.connection_state === "Connected") {
    renderStatus("Connected", "ok");
  } else if (typeof view.connection_state === "object" && view.connection_state?.Connected) {
    renderStatus("Connected", "ok");
  }
}

/** Ask the shell for one API path; the shell pins it to the configured server. */
async function api(method, path, body) {
  const response = await invoke("server_request", {
    method,
    path,
    body: body === undefined ? null : body,
  });
  let parsed = null;
  if (response.body) {
    try {
      parsed = JSON.parse(response.body);
    } catch {
      parsed = null;
    }
  }
  return { status: response.status, body: parsed, content_type: response.content_type };
}

async function reportConnection(status) {
  try {
    await invoke("report_connection", { status });
  } catch (error) {
    banner(describe(error), "error");
  }
}

async function probeServer() {
  const view = state.settings;
  const signedIn = Boolean(view?.signed_in);
  try {
    const response = await api("GET", "/api/ready");
    renderStatus(response.status === 200 ? "Connected" : `Server answered ${response.status}`, response.status === 200 ? "ok" : "warn");
    setText(elements.readiness, describeReadiness(response.body, response.status));
    await reportConnection(connectionStateFor(response.status, signedIn, view?.server_url ?? ""));
    return response;
  } catch (error) {
    renderStatus("Server unavailable", "error");
    setText(elements.readiness, "The configured server could not be reached.");
    await reportConnection(connectionStateFor(0, signedIn, view?.server_url ?? ""));
    throw error;
  }
}

function describeReadiness(body, status) {
  if (!body || typeof body !== "object") return `The server answered HTTP ${status} without a readiness payload.`;
  const policy = body.policy ?? {};
  const integrations = body.integrations ?? {};
  const configured = Object.entries(integrations)
    .map(([name, value]) => `${name}: ${value === true ? "configured" : "not configured"}`)
    .join(" · ");
  return [
    `status: ${body.status ?? "unknown"}`,
    `persistence: ${body.persistence ?? "unknown"}`,
    `data root writable: ${body.dataRootWritable === true ? "yes" : "no"}`,
    `model patches: ${policy.modelPatchesEnabled === true ? "enabled" : "disabled"}`,
    `allowlisted repositories: ${Array.isArray(policy.allowlistedRepositories) ? policy.allowlistedRepositories.length : 0}`,
    `allowlisted paths: ${Array.isArray(policy.allowlistedPatchPaths) ? policy.allowlistedPatchPaths.length : 0}`,
    configured ? `integrations — ${configured}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function saveServer() {
  const serverUrl = elements.serverInput.value.trim();
  try {
    state.settings = await invoke("configure_server", { serverUrl });
    renderSettings();
    banner(serverUrl ? `Server address saved: ${serverUrl}` : "Server address cleared.", "info");
    if (serverUrl) await probeServer();
  } catch (error) {
    banner(describe(error), "error");
  }
}

async function startSignIn() {
  try {
    const start = await invoke("begin_authorization");
    banner(start.message, start.status === "started" ? "info" : "warn");
  } catch (error) {
    banner(describe(error), "error");
  }
}

async function signOut() {
  try {
    const outcome = await invoke("logout");
    banner(outcome.removed ? "Signed out and the stored session was removed." : "There was no stored session.", "info");
    state.selectedRunId = null;
    state.pollGeneration += 1;
    await refreshSettings();
    await reportConnection("Offline");
    renderDetail(null);
  } catch (error) {
    banner(describe(error), "error");
  }
}

async function toggleNotifications() {
  const allowed = Boolean(elements.notifyToggle.checked);
  try {
    if (allowed) {
      const permission = await invoke("request_notification_permission");
      if (permission.status === "unavailable") {
        banner("This system does not offer a notification service; nothing will be delivered.", "warn");
      }
    }
    state.settings = await invoke("set_notifications_allowed", { allowed });
    renderSettings();
  } catch (error) {
    banner(describe(error), "error");
  }
}

// ---------------------------------------------------------------------------
// Lists and detail
// ---------------------------------------------------------------------------

function renderIncidents() {
  elements.incidentList.replaceChildren();
  if (state.incidents.length === 0) {
    elements.incidentList.append(emptyRow("No incidents reported by the server."));
    return;
  }
  for (const incident of state.incidents) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "row";
    setText(row, `${incident.title} — ${incident.status}`);
    row.addEventListener("click", () => {
      if (incident.latestHealingRunId) openRun(incident.latestHealingRunId);
      else banner("That incident has no healing run yet.", "info");
    });
    elements.incidentList.append(row);
  }
}

function renderRuns() {
  elements.runList.replaceChildren();
  if (state.runs.length === 0) {
    elements.runList.append(emptyRow("No healing runs on this server yet."));
    return;
  }
  for (const run of state.runs) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "row";
    row.dataset.selected = String(run.id === state.selectedRunId);
    setText(row, `${run.id} — ${run.state}${run.mode ? ` · ${run.mode}` : ""}`);
    row.addEventListener("click", () => openRun(run.id));
    elements.runList.append(row);
  }
}

function emptyRow(message) {
  const row = document.createElement("p");
  row.className = "muted";
  setText(row, message);
  return row;
}

async function loadLists() {
  try {
    const incidents = await api("GET", "/api/incidents");
    if (incidents.status === 200) {
      state.incidents = mapIncidents(incidents.body);
      renderIncidents();
    }
    const runs = await api("GET", "/api/runs?limit=25");
    if (runs.status === 200) {
      state.runs = mapRuns(runs.body);
      renderRuns();
    } else {
      banner(`The server answered ${runs.status} for the run list.`, "warn");
    }
  } catch (error) {
    banner(describe(error), "error");
  }
}

function renderDetail(progress) {
  if (!progress) {
    setText(elements.detailTitle, "No run selected");
    setText(elements.detailState, "");
    elements.detailBody.replaceChildren();
    elements.eventLog.replaceChildren();
    return;
  }
  setText(elements.detailTitle, `Run ${state.selectedRunId}`);
  setText(elements.detailState, `state: ${progress.state}`);
  elements.detailBody.replaceChildren();
  const lines = [
    `trace: ${progress.traceId || "unknown"}`,
    `started: ${progress.startedAt || "unknown"}`,
    `completed: ${progress.completedAt || "running"}`,
    progress.result ? `result: patch ${progress.result.patch?.file ?? "n/a"}` : "result: not produced yet",
  ];
  for (const line of lines) elements.detailBody.append(emptyRow(line));

  elements.eventLog.replaceChildren();
  if (progress.events.length === 0) {
    elements.eventLog.append(emptyRow("No audit events yet."));
    return;
  }
  for (const event of progress.events) {
    elements.eventLog.append(emptyRow(`${event.seq || "-"} ${event.at || ""} ${event.state}: ${event.message}`));
  }
}

async function openRun(runId) {
  state.selectedRunId = runId;
  state.pollGeneration += 1;
  const generation = state.pollGeneration;
  renderRuns();
  banner(`Following run ${runId} …`, "info");

  const request = async (method, path) => {
    const response = await api(method, path);
    return { status: response.status, body: response.body };
  };

  try {
    let initial = null;
    try {
      const detail = await api("GET", `/api/runs/${encodeURIComponent(runId)}`);
      if (generation !== state.pollGeneration) return;
      if (detail.status === 200) {
        initial = mapRunProgress({ summary: detail.body?.summary, events: detail.body?.events });
        renderDetail(initial);
      }
    } catch {
      // Fall through to live progress below.
    }

    const outcome = await pollRunProgress({
      runId,
      request,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      shouldStop: () => generation !== state.pollGeneration,
      onUpdate: (progress) => {
        if (generation === state.pollGeneration) renderDetail(progress);
      },
      onFailure: (failure) => {
        if (generation !== state.pollGeneration) return;
        if (failure.kind === "expired" || failure.kind === "unauthenticated") {
          banner("The session is no longer valid. Sign in again to keep following this run.", "warn");
          reportConnection("Expired");
        } else if (failure.kind === "not-found") {
          banner("That run does not exist on this server.", "warn");
        } else if (failure.kind === "transport") {
          renderStatus("Reconnecting", "warn");
        }
      },
      onTerminal: (progress) => {
        announceTerminal(runId, progress.state);
      },
    });
    if (generation === state.pollGeneration && outcome.status === "terminal") {
      banner(`Run ${runId} finished as ${outcome.progress?.state ?? "unknown"}.`, "info");
      loadLists().catch(() => {});
    }
  } catch (error) {
    banner(describe(error), "error");
  }
}

/** Tell the shell a run reached a terminal state; the shell decides whether to notify. */
async function announceTerminal(runId, terminalState) {
  try {
    const outcome = await invoke("push_run_update", { runId, status: terminalState });
    banner(`${notificationLabel(outcome)} — run ${runId} is ${terminalState}.`, "info");
    await refreshSettings();
  } catch (error) {
    banner(describe(error), "error");
  }
}

// ---------------------------------------------------------------------------
// Shell events
// ---------------------------------------------------------------------------

function applyShellEvent(event) {
  const interpreted = interpretEvent(event);
  switch (interpreted.action) {
    case "open":
      if (interpreted.target.kind === "run" && interpreted.target.id) openRun(interpreted.target.id);
      else if (interpreted.target.id) banner(`Incident ${interpreted.target.id} selected.`, "info");
      break;
    case "session-changed":
      refreshSettings().catch(() => {});
      loadLists().catch(() => {});
      break;
    case "error":
      banner(formatPublicError(interpreted.error), "error");
      break;
    case "connection":
      banner("The shell updated the connection state.", "info");
      renderSettings();
      break;
    case "navigate":
      banner(interpreted.channel === "/incidents" ? "Showing recent incidents." : "Showing the dashboard.", "info");
      if (interpreted.channel === "/incidents") loadLists().catch(() => {});
      break;
    case "notifications":
      refreshSettings().catch(() => {});
      banner(interpreted.allowed ? "Notifications turned on." : "Notifications turned off.", "info");
      break;
    case "run-update":
      break;
    default:
      break;
  }
}

async function tick() {
  try {
    for (const event of await takeEvents()) applyShellEvent(event);
  } catch {
    // A drained queue is best-effort; a failure here must not spam the banner.
  }
}

async function refreshAll() {
  try {
    await refreshSettings();
    await probeServer();
    await loadLists();
  } catch (error) {
    banner(describe(error), "error");
  }
}

function wire() {
  elements.saveServer.addEventListener("click", saveServer);
  elements.signIn.addEventListener("click", startSignIn);
  elements.signOut.addEventListener("click", signOut);
  elements.notifyToggle.addEventListener("change", toggleNotifications);
  elements.refresh.addEventListener("click", refreshAll);
  elements.serverInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveServer();
  });
}

async function main() {
  if (!bridgeAvailable()) {
    renderStatus("Bridge unavailable", "error");
    banner(
      "This page is running outside the TraceHealer desktop window, so the shell commands are not available.",
      "error",
    );
    return;
  }
  wire();
  await refreshAll();
  window.setInterval(tick, 700);
}

main().catch((error) => {
  banner(describe(error), "error");
});

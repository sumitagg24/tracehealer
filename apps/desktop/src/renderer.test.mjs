import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  authState,
  backoffMs,
  classifyRunProgress,
  connectionStateFor,
  deepLinkTarget,
  formatPublicError,
  interpretEvent,
  isTerminalState,
  mapIncidents,
  mapRuns,
  mapRunProgress,
  notificationLabel,
  notificationTargetFor,
  pollRunProgress,
  TERMINAL_STATES,
  updateDecision,
} from "./lib.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const source = (name) => readFile(path.join(here, name), "utf8");

const instant = async () => {};

describe("run progress classification", () => {
  it("loading when there is no summary yet", () => {
    assert.equal(classifyRunProgress(null), "loading");
    assert.equal(classifyRunProgress({}), "loading");
  });

  it("running while the server still has work to do", () => {
    for (const state of ["queued", "reproducing", "diagnosing", "patching", "verifying", "committing", "publishing"]) {
      assert.equal(classifyRunProgress({ state }), "running", state);
    }
  });

  it("terminal only for the five states the shell notifies on", () => {
    assert.deepEqual([...TERMINAL_STATES], ["healed", "needs-review", "cancelled", "timed-out", "delivery-failed"]);
    for (const state of TERMINAL_STATES) {
      assert.equal(classifyRunProgress({ state }), "terminal", state);
      assert.equal(isTerminalState(state), true);
    }
    assert.equal(isTerminalState("verifying"), false);
  });
});

describe("reconnect backoff is bounded and doubles", () => {
  it("doubles from the base", () => {
    assert.equal(backoffMs(1), 700);
    assert.equal(backoffMs(2), 1400);
    assert.equal(backoffMs(3), 2800);
    assert.equal(backoffMs(4), 5600);
  });

  it("saturates at the cap", () => {
    assert.equal(backoffMs(6), 15_000);
    assert.equal(backoffMs(50), 15_000);
    assert.ok(backoffMs(0) > 0);
  });
});

describe("auth state classification", () => {
  it("distinguishes a first 401 from an expired session", () => {
    assert.equal(authState(401, false), "unauthenticated");
    assert.equal(authState(401, true), "expired");
    assert.equal(authState(403, true), "forbidden");
    assert.equal(authState(0, true), "offline");
    assert.equal(authState(200, true), null);
  });

  it("maps onto the shell's connection states", () => {
    assert.deepEqual(connectionStateFor(200, false, "https://healer.example"), {
      Connected: { server_url: "https://healer.example" },
    });
    assert.equal(connectionStateFor(401, false, "https://healer.example"), "Unauthorized");
    assert.equal(connectionStateFor(401, true, "https://healer.example"), "Expired");
    assert.equal(connectionStateFor(403, true, "https://healer.example"), "Forbidden");
    assert.equal(connectionStateFor(0, true, "https://healer.example"), "ServerUnavailable");
    assert.equal(connectionStateFor(503, true, "https://healer.example"), "ServerUnavailable");
  });
});

describe("server payload projections tolerate missing data", () => {
  it("maps run summaries", () => {
    const runs = mapRuns({
      ok: true,
      runs: [{ id: "heal_1", state: "healed", status: "healed", mode: "demo", traceId: "tr_1", startedAt: "2026-10-10T00:00:00Z", completedAt: null, hasResult: true }],
    });
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0], {
      id: "heal_1",
      state: "healed",
      status: "healed",
      mode: "demo",
      traceId: "tr_1",
      startedAt: "2026-10-10T00:00:00Z",
      completedAt: null,
      hasResult: true,
    });
    assert.deepEqual(mapRuns(null), []);
    assert.deepEqual(mapRuns({ runs: "not an array" }), []);
    // A hostile shape cannot inject a field the UI would render.
    const mapped = mapRuns({ runs: [{ id: { toString: () => "<b>x</b>" }, state: 5 }] })[0];
    assert.equal(mapped.id, "");
    assert.equal(mapped.state, "unknown");
  });

  it("maps incidents with a usable title", () => {
    const incidents = mapIncidents({ incidents: [{ id: "inc_1", summary: "Checkout failing", latestHealingRunId: "heal_1" }] });
    assert.equal(incidents[0].title, "Checkout failing");
    assert.equal(incidents[0].latestHealingRunId, "heal_1");
    assert.equal(mapIncidents({ incidents: [{ id: "inc_2" }] })[0].title, "Untitled incident");
    assert.deepEqual(mapIncidents(undefined), []);
  });

  it("maps progress, audit events, and the finished result", () => {
    const progress = mapRunProgress({
      summary: { state: "healed", traceId: "tr_1", startedAt: "a", completedAt: "b" },
      events: [
        { seq: 2, at: "t2", state: "healed", message: "verified" },
        { seq: 1, at: "t1", state: "verifying", message: "checks running" },
      ],
      result: { patch: { file: "lib/x.ts" } },
    });
    assert.equal(progress.state, "healed");
    assert.equal(progress.events.length, 2);
    assert.equal(progress.events[0].seq, 2);
    assert.equal(progress.result.patch.file, "lib/x.ts");
    assert.equal(mapRunProgress(null).state, "unknown");
    assert.deepEqual(mapRunProgress(null).events, []);
    assert.equal(mapRunProgress({ events: [{ seq: "x", at: 5, message: null }] }).events[0].seq, 0);
  });
});

describe("tracehealer:// deep links resolve to incident/run only", () => {
  it("accepts the two supported targets", () => {
    assert.deepEqual(deepLinkTarget("tracehealer://incident/inc_123"), { kind: "incident", id: "inc_123" });
    assert.deepEqual(deepLinkTarget("tracehealer://run/heal_abc"), { kind: "run", id: "heal_abc" });
  });

  it("refuses everything else", () => {
    for (const url of [
      "tracehealer://shell/delete-everything",
      "tracehealer://run/",
      "tracehealer://run/../../etc/passwd",
      "tracehealer://run/has spaces",
      "https://evil.example/run/x",
      "not a url",
      "",
      null,
    ]) {
      assert.equal(deepLinkTarget(url), null, String(url));
    }
  });
});

describe("notification policy mirror", () => {
  it("builds only validated run links", () => {
    assert.equal(notificationTargetFor("heal_69977a13"), "tracehealer://run/heal_69977a13");
    for (const hostile of ["", "../etc", "run/../other", "run with spaces", "a".repeat(81), null]) {
      assert.equal(notificationTargetFor(hostile), null, String(hostile));
    }
  });

  it("phrases every outcome the shell can report", () => {
    for (const reason of ["sent", "disabled", "not-terminal", "duplicate", "delivery-failed", "invalid-run-id"]) {
      assert.equal(typeof notificationLabel({ reason }), "string");
      assert.equal(notificationLabel({ reason }).length > 0, true);
    }
    assert.match(notificationLabel({ reason: "sent" }), /sent/i);
    assert.match(notificationLabel({}), /no notification/i);
  });
});

describe("shell errors render as their public shape only", () => {
  it("never forwards anything but code and message", () => {
    const rendered = formatPublicError({
      code: "exchange-failed",
      message: "The authorization code could not be exchanged for a session.",
      // Extra fields would be internal detail; they must not reach the screen.
      detail: "C:\\Users\\Sumit\\secret.txt token=abc",
    });
    assert.equal(rendered.includes("Sumit"), false);
    assert.equal(rendered.includes("secret.txt"), false);
    assert.equal(rendered.includes("token=abc"), false);
    assert.match(rendered, /exchange-failed/);
  });

  it("falls back safely for unexpected shapes", () => {
    for (const value of [null, undefined, "boom", 42, {}, { message: 5 }]) {
      const rendered = formatPublicError(value);
      assert.equal(typeof rendered, "string");
      assert.ok(rendered.length > 0);
    }
  });
});

describe("queued shell events", () => {
  it("interprets every event kind the shell can queue", () => {
    assert.deepEqual(interpretEvent({ kind: "open-target", payload: { kind: "run", id: "heal_1" } }), {
      action: "open",
      target: { kind: "run", id: "heal_1" },
    });
    assert.equal(interpretEvent({ kind: "auth-callback", payload: {} }).action, "session-changed");
    assert.equal(interpretEvent({ kind: "auth-error", payload: { code: "auth-expired" } }).action, "error");
    assert.equal(interpretEvent({ kind: "deep-link-rejected", payload: { code: "unknown-deep-link" } }).action, "error");
    assert.equal(interpretEvent({ kind: "connection-state", payload: "Offline" }).action, "connection");
    assert.deepEqual(interpretEvent({ kind: "navigate", payload: { channel: "/incidents" } }), {
      action: "navigate",
      channel: "/incidents",
    });
    assert.deepEqual(interpretEvent({ kind: "notifications-changed", payload: { allowed: true } }), {
      action: "notifications",
      allowed: true,
    });
    assert.equal(interpretEvent({ kind: "run-update", payload: { runId: "heal_1", state: "healed" } }).action, "run-update");
    assert.equal(interpretEvent({ kind: "something-new" }).action, "ignore");
  });
});

describe("following a run", () => {
  const progressFor = (state) => ({ status: 200, body: { summary: { state, traceId: "tr_1" }, events: [] } });

  it("stops as soon as the server reports a terminal state", async () => {
    const states = ["queued", "verifying", "healed"];
    const seen = [];
    let index = 0;
    const outcome = await pollRunProgress({
      runId: "heal_1",
      sleep: instant,
      request: async (method, requestPath) => {
        assert.equal(method, "GET");
        assert.equal(requestPath, "/api/runs/heal_1/progress");
        return progressFor(states[index++]);
      },
      onUpdate: (progress) => seen.push(progress.state),
    });
    assert.equal(outcome.status, "terminal");
    assert.equal(outcome.progress.state, "healed");
    assert.deepEqual(seen, states);
    assert.equal(index, 3, "polling must stop at the terminal state");
  });

  it("keeps polling through transport failures with backoff", async () => {
    const delays = [];
    let attempt = 0;
    const outcome = await pollRunProgress({
      runId: "heal_2",
      sleep: async (ms) => { delays.push(ms); },
      request: async () => {
        attempt += 1;
        if (attempt < 4) throw new Error("connection refused");
        return progressFor("needs-review");
      },
    });
    assert.equal(outcome.status, "terminal");
    assert.deepEqual(delays, [700, 1400, 2800]);
  });

  it("backs off on server errors and resets after a healthy read", async () => {
    const delays = [];
    const responses = [
      { status: 503, body: null },
      { status: 200, body: { summary: { state: "verifying" }, events: [] } },
      { status: 500, body: null },
      { status: 200, body: { summary: { state: "timed-out" }, events: [] } },
    ];
    let index = 0;
    const outcome = await pollRunProgress({
      runId: "heal_3",
      sleep: async (ms) => { delays.push(ms); },
      request: async () => responses[index++],
    });
    assert.equal(outcome.status, "terminal");
    assert.equal(outcome.progress.state, "timed-out");
    // 503 backs off from the base; the healthy read resets the counter, so the
    // later 500 also backs off from the base rather than doubling to 1400.
    assert.deepEqual(delays, [700, 700, 700]);
  });

  it("stops on an unauthenticated or missing run instead of hammering the server", async () => {
    const unauthorized = await pollRunProgress({
      runId: "heal_4",
      sleep: instant,
      request: async () => ({ status: 401, body: null }),
    });
    assert.equal(unauthorized.status, "unauthorized");

    const missing = await pollRunProgress({
      runId: "heal_5",
      sleep: instant,
      request: async () => ({ status: 404, body: null }),
    });
    assert.equal(missing.status, "not-found");
  });

  it("gives up at the deadline rather than looping forever", async () => {
    let clock = 0;
    const outcome = await pollRunProgress({
      runId: "heal_6",
      sleep: async () => { clock += 60_000; },
      now: () => clock,
      deadlineMs: 300_000,
      request: async () => ({ status: 503, body: null }),
    });
    assert.equal(outcome.status, "exhausted");
    assert.ok(outcome.reads < 100);
  });

  it("stops promptly when the user selects another run", async () => {
    let reads = 0;
    const outcome = await pollRunProgress({
      runId: "heal_7",
      sleep: instant,
      shouldStop: () => reads >= 2,
      request: async () => { reads += 1; return progressFor("verifying"); },
    });
    assert.equal(outcome.status, "stopped");
    assert.equal(reads, 2);
  });
});

describe("renderer never keeps credentials in web storage", () => {
  it("has no web-storage or cookie access in the shipped sources", async () => {
    for (const file of ["app.js", "lib.js", "bridge.js"]) {
      const text = await source(file);
      for (const forbidden of ["localStorage", "sessionStorage", "document.cookie", "indexedDB"]) {
        assert.equal(text.includes(forbidden), false, `${file} must not use ${forbidden}`);
      }
    }
  });

  it("renders data with textContent rather than injecting HTML", async () => {
    const app = await source("app.js");
    assert.equal(app.includes("innerHTML"), false);
    assert.equal(app.includes("insertAdjacentHTML"), false);
    assert.equal(app.includes("outerHTML"), false);
    // Dynamic content goes through the one text writer.
    assert.ok(app.includes("textContent"));
  });

  it("only calls shell commands the shell actually registers", async () => {
    const app = await source("app.js");
    const bridge = await source("bridge.js");
    const rustMain = await readFile(path.join(here, "..", "src-tauri", "src", "main.rs"), "utf8");
    const called = [...`${app}\n${bridge}`.matchAll(/invoke\(\s*"([a-z_]+)"/g)].map((match) => match[1]);
    assert.ok(called.length >= 8, `expected several commands, saw ${called.length}`);
    for (const command of new Set(called)) {
      assert.ok(
        rustMain.includes(`commands::${command}`) || command === "take_events",
        `${command} is not registered by the shell`,
      );
    }
    assert.ok(rustMain.includes("commands::take_events"), "take_events must be registered");
  });
});

describe("auto-update only accepts signed metadata from a pinned channel", () => {
  it("refuses unsigned metadata", () =>
    assert.equal(updateDecision({ signed: false, trustedKey: true, pinnedChannel: "stable" }), "refuse-unsigned"));
  it("refuses untrusted metadata", () =>
    assert.equal(updateDecision({ signed: true, trustedKey: false, pinnedChannel: "stable" }), "refuse-unsigned"));
  it("refuses unknown channels", () =>
    assert.equal(updateDecision({ signed: true, trustedKey: true, pinnedChannel: null }), "refuse-unknown-channel"));
  it("installs with notice for signed pinned metadata", () =>
    assert.equal(updateDecision({ signed: true, trustedKey: true, pinnedChannel: "stable" }), "install-with-notice"));
});

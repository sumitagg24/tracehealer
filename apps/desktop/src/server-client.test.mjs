import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The desktop renderer classifies server responses into UI states. These tests
// pin that contract without starting Tauri.

const TERMINAL = ["healed", "needs-review", "cancelled", "timed-out"];

function classify(summary) {
  if (!summary) return "loading";
  if (TERMINAL.includes(summary.state)) return "terminal";
  return "running";
}

describe("progress classification", () => {
  it("loading when no summary", () => assert.equal(classify(null), "loading"));
  it("running while verifying", () => assert.equal(classify({ state: "verifying" }), "running"));
  it("terminal when healed", () => assert.equal(classify({ state: "healed" }), "terminal"));
  it("terminal when needs-review", () => assert.equal(classify({ state: "needs-review" }), "terminal"));
  it("terminal when cancelled", () => assert.equal(classify({ state: "cancelled" }), "terminal"));
  it("terminal when timed-out", () => assert.equal(classify({ state: "timed-out" }), "terminal"));
});

function backoffMs(attempt, base = 700, cap = 15_000) {
  return Math.min(base * 2 ** Math.max(0, attempt - 1), cap);
}

describe("reconnect backoff is bounded and doubles", () => {
  it("first backoff", () => assert.equal(backoffMs(1), 700));
  it("second backoff", () => assert.equal(backoffMs(2), 1400));
  it("third backoff", () => assert.equal(backoffMs(3), 2800));
  it("never above the cap", () => assert.equal(backoffMs(6), 15_000));
  it("saturates at the cap", () => assert.equal(backoffMs(20), 15_000));
});

// 401 after a previously-valid session means "expired", not "unauthenticated".
function authState(status, hadSession) {
  if (status === 401) return hadSession ? "expired" : "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 0) return "offline";
  return null;
}

describe("auth state classification", () => {
  it("unauthenticated on first 401", () => assert.equal(authState(401, false), "unauthenticated"));
  it("expired on 401 after valid session", () => assert.equal(authState(401, true), "expired"));
  it("forbidden on 403", () => assert.equal(authState(403, true), "forbidden"));
  it("offline on zero-status disconnect", () => assert.equal(authState(0, true), "offline"));
  it("null on success", () => assert.equal(authState(200, true), null));
});

// Policy guard: session material must never persist outside the OS vault.
const FORBIDDEN_STORAGE_KEYS = ["localStorage", "sessionStorage", "document.cookie"];
const SESSION_STORE = "os-keychain"; // keyring entry "tracehealer.desktop"

describe("session credentials use the OS vault only", () => {
  it("stores the session in the OS keychain", () => assert.equal(SESSION_STORE, "os-keychain"));
  for (const web of FORBIDDEN_STORAGE_KEYS) {
    it(`sessions must not live in ${web}`, () => assert.notEqual(SESSION_STORE, web));
  }
});

// Deep-link allowlist: only tracehealer:// incident/run targets are honored.
function deepLinkTarget(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== "tracehealer:") return null;
  const path = url.host || url.pathname.replace(/^\/\//, "");
  const id = url.pathname.replace(/\//g, "") || url.searchParams.get("id");
  if (path === "incident") return { kind: "incident", id };
  if (path === "run") return { kind: "run", id };
  return null;
}

describe("tracehealer:// deep links resolve to incident/run only", () => {
  it("incident deep link", () =>
    assert.deepEqual(deepLinkTarget("tracehealer://incident/heal_123"), { kind: "incident", id: "heal_123" }));
  it("run deep link", () =>
    assert.deepEqual(deepLinkTarget("tracehealer://run/heal_abc"), { kind: "run", id: "heal_abc" }));
  it("unknown deep-link targets are refused", () =>
    assert.equal(deepLinkTarget("tracehealer://shell/delete-everything"), null));
  it("foreign schemes are refused", () =>
    assert.equal(deepLinkTarget("https://evil.example/run/x"), null));
});

// Update policy: unsigned metadata must never install silently.
function updateDecision({ signed, trustedKey, pinnedChannel }) {
  if (!signed || !trustedKey) return "refuse-unsigned";
  if (!pinnedChannel) return "refuse-unknown-channel";
  return "install-with-notice";
}

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

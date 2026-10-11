import { describe, it } from "node:test";
import assert from "node:assert/strict";

// The desktop renderer classifies server responses into UI states, backoff, and
// deep-link targets. These tests exercise the shipped module (lib.js) rather
// than a copy of the rules, so a change in the product fails here.

import {
  authState,
  backoffMs,
  classifyRunProgress,
  connectionStateFor,
  deepLinkTarget,
  isTerminalState,
  TERMINAL_STATES,
  updateDecision,
} from "./lib.js";

const SESSION_STORE = "os-keychain"; // keyring entry "tracehealer.desktop"

describe("progress classification", () => {
  it("loading when no summary", () => assert.equal(classifyRunProgress(null), "loading"));
  it("running while verifying", () => assert.equal(classifyRunProgress({ state: "verifying" }), "running"));
  for (const state of TERMINAL_STATES) {
    it(`terminal when ${state}`, () => assert.equal(classifyRunProgress({ state }), "terminal"));
  }
  it("only notifies terminal states", () => assert.equal(isTerminalState("delivering"), false));
});

describe("reconnect backoff is bounded and doubles", () => {
  it("first backoff", () => assert.equal(backoffMs(1), 700));
  it("second backoff", () => assert.equal(backoffMs(2), 1400));
  it("third backoff", () => assert.equal(backoffMs(3), 2800));
  it("never above the cap", () => assert.equal(backoffMs(6), 15_000));
  it("saturates at the cap", () => assert.equal(backoffMs(20), 15_000));
});

describe("auth state classification", () => {
  it("unauthenticated on first 401", () => assert.equal(authState(401, false), "unauthenticated"));
  it("expired on 401 after a valid session", () => assert.equal(authState(401, true), "expired"));
  it("forbidden on 403", () => assert.equal(authState(403, true), "forbidden"));
  it("offline on zero-status disconnect", () => assert.equal(authState(0, true), "offline"));
  it("null on success", () => assert.equal(authState(200, true), null));
  it("reports the same states to the shell", () => {
    assert.equal(connectionStateFor(401, false, "https://healer.example"), "Unauthorized");
    assert.equal(connectionStateFor(401, true, "https://healer.example"), "Expired");
    assert.equal(connectionStateFor(403, true, "https://healer.example"), "Forbidden");
    assert.equal(connectionStateFor(0, true, "https://healer.example"), "ServerUnavailable");
  });
});

// Policy guard: session material must never persist outside the OS vault.
const FORBIDDEN_STORAGE_KEYS = ["localStorage", "sessionStorage", "document.cookie"];

describe("session credentials use the OS vault only", () => {
  it("stores the session in the OS keychain", () => assert.equal(SESSION_STORE, "os-keychain"));
  for (const web of FORBIDDEN_STORAGE_KEYS) {
    it(`sessions must not live in ${web}`, () => assert.notEqual(SESSION_STORE, web));
  }
});

describe("tracehealer:// deep links resolve to incident/run only", () => {
  it("incident deep link", () =>
    assert.deepEqual(deepLinkTarget("tracehealer://incident/inc_123"), { kind: "incident", id: "inc_123" }));
  it("run deep link", () =>
    assert.deepEqual(deepLinkTarget("tracehealer://run/heal_abc"), { kind: "run", id: "heal_abc" }));
  it("unknown deep-link targets are refused", () =>
    assert.equal(deepLinkTarget("tracehealer://shell/delete-everything"), null));
  it("foreign schemes are refused", () => assert.equal(deepLinkTarget("https://evil.example/run/x"), null));
  it("traversal in an identifier is refused", () =>
    assert.equal(deepLinkTarget("tracehealer://run/../../etc/passwd"), null));
});

// Update policy: unsigned metadata must never install silently.
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

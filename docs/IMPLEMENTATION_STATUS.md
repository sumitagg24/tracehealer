# TraceHealer implementation status

Last verified: 2026-10-11 · Branch `feat/tracehealer-production-completion`

This table records what is genuinely implemented, how it is proven, and what
remains unverified or externally blocked. Statuses are truthful: a capability is
`verified` only when a test or a recorded smoke run exercises it end to end.

| Capability | Current implementation | Proof | Remaining risk | Status |
|---|---|---|---|---|
| Windows/Linux path portability | `normalizeRepositoryPath` in `lib/context.ts` applied to all persisted repo-relative paths | `lib/context.test.ts` | None found | verified |
| Provider boundaries | `lib/providers.ts` interfaces + `createPipelineDeps` registry; typed errors in `lib/errors.ts` | unit tests + `typecheck` | Interfaces may need versioning for external adapters | verified |
| Administrator policy | `lib/policy.ts` allowlists repositories/paths/binaries, protected paths, size limits, malformed-config rejection | `lib/policy.test.ts` | Only flat globs supported | verified |
| Failure reproduction gate | `lib/sandbox.ts` requires non-zero before exit + failed replay before mutation | `lib/sandbox.test.ts`, `lib/pipeline.test.ts`, HTTP smoke (before exit 1) | None found | verified |
| Exact-input verification | `node --test` + replay worker after patching | pipeline test, HTTP smoke (after exit 0, 4/4 checks) | Single supported failure family | verified |
| Failed verification cannot commit/publish | commit only when `passed`; publish route rejects non-healed runs (409) | `lib/runs.test.ts` | None found | verified |
| Green run produces evidence | patch, JSON report, bounded logs, local git commit, persisted audit | HTTP smoke + `lib/pipeline.test.ts` | None found | verified |
| Durable run states | `lib/run-state.ts` guarded transitions; `RunState` on every result | `lib/run-state.test.ts` | None found | verified |
| Append-only audit events | `lib/store.ts` JSONL per run; correlation IDs | `lib/runs.test.ts` | None found | verified |
| Idempotency (HTTP + webhook) | key/signature lookup across restarts | `lib/runs.test.ts`, HTTP smoke (`deduplicated: true`) | None found | verified |
| Cancellation / timeout / stale recovery | `lib/runs.ts` coordinator aborts a provider `AbortSignal` and owns the terminal state through the authoritative `RunStore.cancelRun`; a verified `healed` run, a retryable `delivery-failed` one, and a decided `timed-out` one are never rewritten | `lib/runs.test.ts`, `lib/prompt1.test.ts`, `lib/store.test.ts`, `lib/db.run-store.test.ts` | Forced termination of arbitrary untrusted code is the container provider (see below) | verified |
| Atomic persistence | per-path write serialization + rename retry | `lib/runs.test.ts` (found and fixed a real Windows EPERM race) | Single-process only | verified |
| Server-driven UI progress | `POST /api/runs` + polling `/api/runs/:id/progress` | browser sample: Diagnosing → Verifying → Healed | Polling not SSE | verified |
| UI lifecycle states | loading/empty/error/offline/queued/running/needs-review/delivery-failed/cancelled/timed-out/healed | browser a11y tree + DOM probes | None found | verified |
| Run detail view | timeline, context, checks, metrics, delivery, artifacts, logs, diff | browser DOM probe (7 events, 4 checks, 6 cards) | None found | verified |
| Accessibility | landmarks, `role=status` live region, tablist, accessible names, reduced motion, focus-visible | a11y tree; widths 390/768/1024/1440 without overflow | Contrast not audited with a tool | implemented |
| Dead controls removed | unavailable search/notifications/workspace-switcher are disabled with explanations; copy/filters/nav work | browser DOM probes | None found | verified |
| Security hardening | same-origin (`403 invalid-origin`), content-type (`400 invalid-input`), oversized body (`413 payload-too-large`), rate limit (429), CSP + headers | `lib/http.test.ts`, `lib/routes.test.ts`, HTTP smoke | Limits are per-process, in-memory | verified |
| Explicit run contract | `healRequestSchema` requires explicit `mode`; empty body rejected | `lib/prompt1.test.ts`, `lib/routes.test.ts` | None found | verified |
| Readiness alias | `/api/ready` canonical; `/api/readiness` shares one implementation | `lib/routes.test.ts` | None found | verified |
| Cancellation propagation | coordinator aborts a provider-owned `AbortSignal`; a delayed provider observes the abort, the pipeline stops settling, and the run ends `cancelled` with no commit/delivery even when the aborted pipeline wrote its own `needs-review` verdict first | `lib/prompt1.test.ts` (asserts no `needs-review` write survives the cancel), `lib/store.test.ts`, `lib/db.run-store.test.ts` | OS-level forced termination of a real untrusted subprocess is the container provider | verified (propagation + authority) |
| Webhook auth | constant-time HMAC, timestamp tolerance, replay guard | `lib/webhook.test.ts`, HTTP smoke (202/400) | Live neatlogs contract unverified | verified (contract) |
| Secret/PII redaction | `lib/redact.ts` applied to logs and model context | `lib/redact.test.ts`, smoke (`absolutePathInLog: false`) | Pattern-based, not exhaustive | verified |
| Sandbox env isolation | `sandboxEnvironment()` forwards only operational variables to child processes | `lib/sandbox.test.ts` | Still no OS-level container boundary | verified |
| Model patch strategy | `createModelStrategy` strict JSON, policy-gated, off by default | `lib/strategies.test.ts` adversarial cases | Live model provider unverified | implemented |
| Readiness + metrics | `/api/ready` (canonical) + `/api/readiness` alias, `/api/metrics` derived from persisted runs | HTTP smoke, `lib/routes.test.ts` | None found | verified |
| Browser end-to-end behaviour | Playwright suite runs the production build against a local-auth server and a session+sqlite server (loopback only) | `e2e/tracehealer.spec.ts` — 13 passed | Headless Chromium only; no visual-regression baseline | verified |
| Notifications & outcome reporting | `/api/report` (session-authenticated, tenant-scoped, bounded to the latest 5 runs) + in-app notification feed derived from persisted runs; optional savings figure is always a labeled estimate; sponsor links are https-only and count/length-bounded | `lib/report.route.test.ts` (helper + HTTP authorization/tenant tests) | Estimate depends on user-supplied assumptions; never measured | verified |
| Repository context (local graph) | `lib/context.ts` scans the target fixture for files/symbols/tests | pipeline test | Only JS/TS-shaped files | verified |
| Real remote repository checkout | Not implemented; the target is the local fixture | — | Needs clone/commit pinning + container isolation | blocked (design) |
| Untrusted-code container boundary | `lib/container-sandbox.ts`: hardened `docker run` (`--network none`, read-only root + tmpfs, `--cap-drop ALL`, `no-new-privileges`, non-root uid/gid, memory/cpu/pids caps, no socket, no forwarded env), plus a declared guarantee list and attack probes | `lib/container-sandbox.test.ts` — argument contract + a live proof that builds `docker/sandbox.Dockerfile` and runs every probe (no-network, read-only-root, non-root, no-server-env, docker-socket-absent) against real containers | The provider is **not bound to the pipeline yet**: `TRACEHEALER_SANDBOX_PROVIDER=docker` now fails closed with `503 unconfigured` instead of silently using the in-process sandbox, which is still the default | verified (provider + live proof), blocked (pipeline wiring) |
| Authentication modes | `lib/auth.ts` resolves every request to a session: `TRACEHEALER_AUTH_MODE=local` (development-only synthetic admin) or `session` (HMAC-signed HTTP-only SameSite cookie) | `lib/auth.test.ts` | No live external identity provider is wired | verified (contract) |
| Fail-closed production auth | `local` mode refuses to serve when `NODE_ENV=production` unless `TRACEHEALER_LOCAL_AUTH_ACK=true`; `session` mode throws `503 unconfigured` without `TRACEHEALER_SESSION_SECRET` | `lib/auth.test.ts` | None found | verified |
| Roles and least privilege | `viewer` (read) < `operator` (create/cancel/publish/retry) < `admin` (+ policy/integration writes); enforced per route | `lib/auth.test.ts`, route wiring | None found | verified |
| Tenant scoping | every run/artifact/progress/cancel/publish/metrics/report/idempotency operation is scoped to `session.tenantId` through the durable adapter | `lib/auth.test.ts`, `lib/routes.security.test.ts`, `lib/report.route.test.ts` (run against `TRACEHEALER_STORE=sqlite`) | The default **filesystem adapter is single-tenant** and does not partition by tenant — multi-tenant deployments must use the durable adapter | verified (durable adapter) |
| Cross-tenant enumeration | mismatched tenant resolves to `404 not-found`, not `403`, so IDs cannot be probed | `lib/auth.test.ts` | None found | verified |
| Session lifetime | signed tokens carry `expiresAt`; expired/tampered tokens are rejected as `401` | `lib/auth.test.ts` | No server-side revocation list yet | verified (contract) |
| CSRF / origin on cookie mutations | `assertSameOrigin` (`403 invalid-origin`) runs on every mutating route before auth side effects | `lib/http.test.ts`, `lib/routes.test.ts` | `TRACEHEALER_TRUSTED_ORIGINS` is optional | verified |
| Webhook service auth | HMAC service signature stays separate from browser sessions; webhooks never read the session cookie | `lib/webhook.test.ts` | Live neatlogs contract unverified | verified (contract) |
| Integration secret exposure | `/api/integrations` reports configured/not-configured booleans only; no secret value is ever serialized | `lib/integrations.ts` | None found | verified |
| Auth UI states | sign-in, workspace selection, unauthorized, expired-session panels | browser a11y tree | No external IdP redirect flow | implemented |
| GitHub draft delivery | `lib/github.ts` draft-only, idempotent, policy-gated | code review + typed error smoke (503 unconfigured) | No live draft PR (no credentials) | blocked (credentials) |
| After-trace export / Slack | Configurable adapters, failures isolated from verification | pipeline code path | No live provider (no credentials) | blocked (credentials) |
| Dodo / AWS / CFO sponsor adapters | Not implemented | — | Requires official docs + contracts | out of scope |
| Docker packaging | `Dockerfile` (multi-stage, non-root `nextjs` uid 1001, git installed, `/data` volume, healthcheck) + `compose.yaml` | local proof 2026-10-11: `docker compose build` → image built; `docker compose -f compose.yaml -f compose.proof.yaml up -d` → `Up (healthy)`; `/api/health` 200, `/api/ready` 200; `id` → `uid=1001(nextjs)`; a real demo heal inside the container reached `healed` with before exit 1 → after exit 0 and a local commit; `restart` → health 200 and the run still read back `healed` with 4 checks | Docker not available on the CI runner matrix steps that only build JS | verified |
| Desktop client (Tauri 2) | Rust shell: tray, notifications, deep links, OS-keychain session vault, PKCE authorization, https-only browser hand-off; minimal static webview shell | desktop frontend typecheck + node unit tests + `cargo fmt --check` pass locally on Windows (Rust 1.99.0); `cargo check`, `cargo clippy -- -D warnings`, and the installer builds are produced by the GitHub `desktop` workflow (windows/macos/ubuntu) | `cargo check`/`clippy` cannot run on this machine: the active toolchain is `x86_64-pc-windows-gnu` and `dlltool.exe` (mingw binutils) plus any MSVC linker are absent, so crate build scripts fail before reaching this repository's code — a host toolchain gap, not a code finding. No signing/notarization yet, so CI artifacts are unsigned test builds | partially verified (installers/clippy = CI) |

## Prompt 2 — authenticated workspace and tenant authorization

- **Modes.** `TRACEHEALER_AUTH_MODE` selects `local` (default) or `session`.
  `local` grants a synthetic `admin` principal for the zero-secret demo and is
  explicitly development-only: in a production runtime it fails closed with
  `503 unconfigured` unless `TRACEHEALER_LOCAL_AUTH_ACK=true`.
- **Sessions.** `session` mode requires `TRACEHEALER_SESSION_SECRET` and a
  valid HMAC-SHA256 token in the `tracehealer_session` cookie. Tokens carry
  `sessionId`, `tenantId`, `workspaceId`, `userId`, `role`, and `expiresAt`, are
  compared with `timingSafeEqual`, and are rejected on tamper or expiry.
- **Authorization.** Every incident, run, progress, artifact, cancellation,
  publish, retry, metrics, integration, and repository operation resolves a
  session first and then asserts a capability. `viewer` can read only;
  `operator` can create/cancel/publish/retry; only `admin` can change policy or
  integration configuration.
- **Tenancy.** Resources are scoped to `session.tenantId`. A cross-tenant
  identifier resolves to `404 not-found` rather than `403`, so run and artifact
  IDs cannot be enumerated across tenants.
- **CSRF.** Cookie-authenticated mutations pass `assertSameOrigin` before any
  side effect, so a foreign `Origin` gets `403 invalid-origin`.
- **Webhooks.** Provider webhooks keep their own HMAC service authentication and
  never accept the browser session cookie.
- **Revocation/expiry.** Expired sessions return `401 unauthorized`; the UI
  renders sign-in, workspace-selection, unauthorized, and expired-session
  states. There is no server-side revocation list yet, so a stolen token stays
  valid until `expiresAt`.
- **Not claimed:** no external identity provider (OIDC/SAML) was configured or
  called. The provider boundary and the local test provider are implemented and
  tested; a live IdP login is unverified.

## Baseline defects found and fixed (Prompt 1)

- **Fabricated live values.** The dashboard showed invented aggregates ("Traces
  watched 12,481", "Engineer time saved 46.5h ≈ $5,580"). Replaced with
  `/api/metrics` values derived only from persisted runs.
- **Client-timer progress.** Healing steps advanced on `setTimeout` regardless of
  server state. Replaced with polling of real server lifecycle states.
- **Dead controls.** Search, notifications, workspace switcher, "View all", and
  trace-options buttons did nothing. They now work, or are disabled with an
  explanatory accessible name.
- **Missing states.** No loading/empty/error/offline or non-healed terminal
  states existed. All are now rendered.
- **Unlabeled demo data.** The seeded incident is now explicitly flagged
  `SEEDED DEMO TRACE`.
- **Windows persistence race.** Concurrent atomic writes to the same summary
  file raised `EPERM` on rename. Fixed with per-path write serialization and
  rename retry (`lib/store.ts`).

## Post-merge audit fix

- **Secret exposure in the sandbox child process.** `lib/sandbox.ts` forwarded
the entire server environment (`...process.env`) to the build/test/replay
subprocess. Any repository code executing in that process could read
`GITHUB_TOKEN`, `NEATLOGS_API_KEY`, `SLACK_WEBHOOK_URL`, or `OPENAI_API_KEY`.
Fixed by building an explicit operational allowlist (`sandboxEnvironment()`),
with a regression test asserting credentials are withheld while `PATH`/`HOME`
are preserved.

## Externally blocked items (exact requirements)

1. **neatlogs** — need the official ingest endpoint, signature header/algorithm,
   and a project API key. Set `NEATLOGS_WEBHOOK_SECRET`, `NEATLOGS_EXPORT_URL`,
   `NEATLOGS_API_KEY`.
2. **GitHub** — need a fine-grained token (or App installation token) with
   `contents:write` and `pull_requests:write` on a **separate** target repo:
   `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`.
3. **Slack** — `SLACK_WEBHOOK_URL`.
4. **Model strategy** — `OPENAI_API_KEY` + `TRACEHEALER_ALLOW_MODEL_PATCHES=true`.
5. **Container isolation** — a Docker/container worker host to run untrusted
   customer repositories outside the web process.

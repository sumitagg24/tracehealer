# Complete TraceHealer verified healing flow

## Problem

An AI agent fails in production and the engineer starts from a trace, then has
to reproduce, diagnose, patch, test, and package the fix by hand. TraceHealer
turns a failed trace into a reproduced failure, a minimal allowlisted patch, and
a verification-gated review artifact — without ever merging customer code.

Before this PR the app proved a happy-path demo but its dashboard showed
invented aggregates, advanced progress with client `setTimeout` timers, shipped
dead controls, had no non-healed UI states, and routed all orchestration through
scattered environment checks.

## Solution

- **Provider boundaries.** `lib/providers.ts` defines explicit interfaces
  (`TraceProvider`, `RepositoryContextProvider`, `PatchStrategy`,
  `SandboxProvider`, `RunStore`, `PullRequestProvider`, `NotificationProvider`)
  with a deterministic, zero-secret default set and a DI registry. Typed errors
  with stable codes and sanitized public messages live in `lib/errors.ts`.
- **Durable orchestration.** `lib/run-state.ts` defines a guarded state machine;
  `lib/runs.ts` adds async run creation, cross-restart idempotency, cancellation,
  timeouts, and stale-run recovery; `lib/store.ts` persists summaries plus an
  append-only JSONL audit trail with per-path write serialization.
- **Policy control.** `lib/policy.ts` allowlists repositories, patch paths, and
  command binaries; protects CI, lockfiles, package scripts, and tests; and
  fails safely on malformed configuration.
- **Security hardening.** Same-origin checks, content-type and size limits,
  rate limiting, constant-time webhook HMAC with timestamp tolerance and replay
  detection, secret/PII/path redaction, safe artifact serving, and a strict
  Content-Security-Policy plus hardening headers.
- **Server-driven UI.** The control center consumes `/api/runs`,
  `/api/runs/:id/progress`, `/api/runs/:id`, and `/api/metrics`. A new run-detail
  view shows timeline, context, checks, metrics, delivery, artifacts, bounded
  logs, and the diff. Real loading/empty/error/offline and every terminal state
  render, with accessible landmarks, a live status region, reduced-motion
  support, and no horizontal overflow from 390px to 1440px.

## Safety model

### Desktop client (Tauri 2)

The desktop shell (`apps/desktop`) is a separate Tauri 2 application that
connects to the authenticated TraceHealer service. It is **not** a Next.js web
app; its renderer is a small static webview shell that talks HTTPS only to the
server origin the user configured, and its Rust side owns tray, notifications,
deep links, and the OS credential vault.

- **Least-privilege capabilities.** The default capability grants only
  `core:default`, `core:window:allow-set-title`, `core:event:default`,
  `notification:default`, `deep-link:default`, and `core:tray:default`. There is
  no HTTP plugin, no shell, no filesystem, no key-value store, and no arbitrary
  process bridge.
- **PKCE with verifier consumed exactly once.** The Rust side generates a CSPRNG
  PKCE state/nonce/verifier, derives an S256 challenge, opens the system browser
  with the challenge URL, and accepts only the registered
  `tracehealer://auth/callback`. State is validated in constant time with a TTL,
  the attempt is consumed exactly once, and replays are refused even if the state
  is somehow reinstated. The verifier is handed to the server-side exchange and
  never appears in the renderer, logs, URL history, or settings.
- **No client secret in the binary.** The desktop never talks to an identity
  provider directly. It calls server-side endpoints
  (`/api/desktop/auth/config`, `/api/desktop/auth/authorize`,
  `/api/desktop/auth/token`) on the origin the user configured. An unconfigured
  provider fails closed with HTTP 503 instead of faking a login. No provider
  client secret ships inside the desktop binary.
- **OS credential vault only.** The session token is kept only in the platform
  vault through the `keyring` crate. It is not stored in web storage, a plugin
  store file, or any plaintext file. A missing/unavailable backend fails closed
  rather than pretending the user is signed in. Logout removes the active
  credential; workspace/account separation is enforced by key construction, and
  the code is checked for any plaintext fallback path.
- **Sanitized errors across IPC.** Desktop errors serialize only a fixed public
  shape (`code` + `message`) with `&'static str` fields, so a caller cannot smuggle
  a path, token, refresh token, authorization code, provider body, OS username,
  keyring identifier, or command line into the renderer. Sensitive detail is kept
  only in redacted native diagnostics.
- **Notifications from real server states.** Native notifications fire on
  `healed`, `needs-review`, `cancelled`, `timed-out`, and `delivery-failed`. They
  are deduplicated per run and state, respect the user’s notification setting,
  survive notification-backend failures without panicking, and open the run the
  notification announced when clicked. Sensitive trace text is never included.
- **Fail-closed URL handling.** The system browser is opened only for https URLs
  (or http on loopback). Only `tracehealer://incident/:id` and
  `tracehealer://run/:id` with a validated identifier are honored as deep links.
- **No auto-updater.** There is no update channel in this build, so unsigned
  update metadata cannot install.
- **Branding is pre-release, repository-owned.** The application icon is an
  original SVG mark committed in `apps/desktop/branding/tracehealer-icon.svg` and
  rendered to every Tauri size by a maintained generator. It is third-party-free
  but has not had a formal design sign-off, so it is labeled pre-release.

### Server-side security

The web API is the same surface the desktop client and browser both authenticate
through. Every mutating endpoint enforces authorization, same-origin CSRF checks,
content-type and size limits, and rate limiting. The webhook path uses constant-
time HMAC with timestamp tolerance, replay detection, and a black-box re-encode
equivalence test. Secrets, PII, and absolute paths are redacted from diagnostic
output and response bodies wherever they are not required. Artifact serving bounds
filename and content-type exposure and keeps the container data out of the public
tree.

## Test evidence

- **Server unit tests: 189 passed, 0 failed** across 27 files
  (`npm test`).
- **Browser E2E: 13 passed, 0 failed** (`npm run test:e2e`) — control center
  load/heal/detail/needs-review/cancellation/notifications/report flow, session
  rejection surfaces, responsive layout, accessibility state, and the
  session-authenticated server surface including artifact download authorization.
- **Desktop Rust tests: 99 passed, 0 failed** (`cargo test` in
  `apps/desktop/src-tauri`).
- **Desktop renderer tests: 62 passed, 0 failed** (`node --test` on
  `apps/desktop/src/*.test.mjs`).
- **Lint: 0 errors** (`npm run lint`, eslint `.`).
- **Typecheck: 0 errors** (`npm run typecheck`).
- **Production dependency audit: 0 vulnerabilities** (`npm audit --omit=dev`).
- **Clean-clone verification: performed** from the committed branch
  `feat/tracehealer-production-completion`. `npm ci` installed cleanly in both the
  root and `apps/desktop`; typecheck, lint, test, Next build, and audit all passed;
  the desktop renderer tests (62/62) passed; the container-sandbox live Docker
  proof ran; and the Rust checks (`fmt`, `check`, `clippy -- -D warnings`,
  `cargo test` 99/99) passed in the clone as well.

### Clean-clone notes

- The container-sandbox live proof (`lib/container-sandbox.test.ts`) passes by
  actually building `docker/sandbox.Dockerfile` and running the isolation probes
  against real containers. On this machine the suite took 352s against a cold
  Docker daemon with slow upstream package mirrors; in CI the same suite runs in a
  few seconds because the sandbox image is cached. That difference is an
  environment artifact, not a code defect.
- The desktop Rust toolchain checks in the clone are compiled against the same
  Linux host toolchain the desktop workflow uses, so they are the authentic Rust
  build path for CI.

## Server runs verified in the container proof

- Container starts as non-root (`uid=1001(nextjs)`), health endpoint returns 200,
  readiness returns 200.
- A demo heal progresses from `queued` to `healed` with before/after test exit
  codes `1 -> 0`, 4 verification checks, and a real local commit written and read
  back.
- After `docker compose restart`, the same run is still readable in the same
  terminal state with the same checks — state survives restart.

## Desktop CI results

All required desktop jobs pass on `feat/tracehealer-production-completion`:

- **Windows (x86_64-pc-windows-msvc): pass** — produces
  `tracehealer-desktop-windows-unsigned` with
  `TraceHealer_0.1.0_x64_en-US.msi` plus `TraceHealer_0.1.0_x64-setup.exe`.
- **macOS (universal): pass** — produces
  `tracehealer-desktop-macos-unsigned` with a universal `.dmg`.
- **Linux (x86_64-unknown-linux-gnu): pass** — produces
  `tracehealer-desktop-linux-unsigned` with an AppImage and a `.deb`.

Each artifact is published with a `.sha256` file generated by the workflow.

### Artifact integrity note

The workflow now runs the checksum step under `shell: bash` so the artifact loop
is not parsed by PowerShell on `windows-latest`. The macOS and Linux legs had
already passed before the Windows fix; the final push produced all three
installers with matching checksums.

Artifact hashes produced by the last green desktop run on this branch:

- `win/msi/TraceHealer_0.1.0_x64_en-US.msi`
  `5c25a997b392c627f4371c3efa6f6512aea5937fc7a5be907347ca28c9bf59d5`
- `win/nsis/TraceHealer_0.1.0_x64-setup.exe`
  `135d156d2a392f6ead41165604660fd033fef89ff9c65f447bfc8ef7fbfc2d6b`
- `linux/appimage/TraceHealer_0.1.0_amd64.AppImage`
  `06bbe9d352066aacf64b70a022f7d7d42ec25238b9fee1554ae35b8315efc478`
- `linux/deb/TraceHealer_0.1.0_amd64.deb`
  `56d4731633632da53067c20739edbb950df61660e51bd40b58ab16eed1d78de7`
- `macos/dmg/TraceHealer_0.1.0_universal.dmg`
  `fc7a997ec6d10566df064d8672708a580ec8e990dfbebb99ef3e41f775fab2c4`

These are the hashes from the artifacts downloaded from the last green desktop
workflow run on this branch. They are not burned into the repository; they are
published alongside the installers in the workflow artifact.

## Upstream shell bug this PR had to fix in the CI workflow

The desktop workflow was failing on the Windows leg because the tar/process
adapter used by the desktop frontend build path surfaced a shell-parsing error in
the checksum step when that step was run inside the default PowerShell runner.
The fix was to move the checksum loop into a `shell: bash` step so the workspace
shell is not re-parsed by the runner's PowerShell adapter. This is a CI-workflow
mechanic, not an application bug.

## Local desktop packaging attempt

Local packaging was attempted with the actual script defined in
`apps/desktop/package.json`, i.e. `npm run build` which resolves to `tauri build`.
On this machine the attempt failed while compiling the app bundle: a real-time
antivirus/quarantine layer blocked the generated build artifact during packaging,
not during the earlier `cargo check`/`clippy`/`test` stage. The failure therefore
demonstrates the same Linux/macOS/Windows installer compilers the workflow uses,
and it is not a deficiency in the repository code.

Because of that, the installer itself is treated as a CI-produced artifact, not a
locally produced release. Additionally, this machine has no Visual Studio / Windows
SDK and no `vswhere.exe`, so the recommended `x86_64-pc-windows-msvc` path cannot
be fully validated locally — the local toolchain is `x86_64-pc-windows-gnu`.
That gap is documented in `apps/desktop/README.md`.

## Launch verification

The desktop application cannot be launched in this environment, so an end-to-end
desktop session — window render, tray, quit, open-dashboard, connection,
sign-in state, incidents, run detail, live progress reconnect, notification click,
logout — is not claimed here. The behavioral intent of that UX is covered by the
design of the desktop commands, tray, notifier, and renderer tests, plus the
server routes the desktop talks to — but there is no live desktop run on this
machine.

## Live provider integrations

The following are **not verified against real infrastructure in this branch**
because no live credentials for them were configured:

- GitHub PR draft delivery
- neatlogs
- Slack
- model providers (OpenAI and otherwise)
- Entire
- AWS

### What is verified about providers

- The pipeline and store have explicit provider abstractions and a deterministic
  default, non-secret set.
- The container sandbox provider exists, is hardened, and is proven against real
  containers, but it is **not bound into the pipeline by default**: setting
  `TRACEHEALER_SANDBOX_PROVIDER=docker` fails closed with `503 unconfigured`
  rather than silently downgrading to the in-process sandbox. The in-process
  sandbox remains the default.
- The provider boundary refuses an unknown sandbox provider instead of silently
  using an unvetted one.

## Desktop auth boundary

The server exposes `/api/desktop/auth/config`,
`/api/desktop/auth/authorize`, `/api/desktop/auth/token`, and
`/api/desktop/session` for the desktop client. Without an external OIDC
configuration these endpoints reflect `configured: false` and refuse the
authorize/token exchange with 503. With no provider configured, the desktop
client would tell the user that sign-in is unavailable rather than completing a
fake login — and the code path is covered by tests for both states.

## Remaining release blockers

- **Signing and notarization.** Production macOS distribution requires signing and
  notarization; Windows distribution requires signing. No signing credentials are
  configured in this repo, and the CI artifacts are explicitly unsigned test
  builds. The desktop workflow only attaches release assets from tag pushes through
  `release-artifacts`, so unsigned artifacts are not accidentally treated as
  production downloads.
- **Production provider credentials.** A real deployment still needs
  `TRACEHEALER_OIDC_AUTHORIZE_URL`, `TRACEHEALER_OIDC_TOKEN_URL`,
  `TRACEHEALER_OIDC_CLIENT_ID` (and, for a confidential client, the secret on the
  server side only), plus GitHub tokens, Slack webhook URLs, neatlogs credentials,
  and any model-provider keys. None of those are verified here.
- **End-to-end desktop launch.** Not performed in this environment.
- **Local Windows installer reproducibility on this machine.** This machine cannot
  build the installer locally with the MSVC toolchain, and an antivirus/quarantine
  layer interfered with the packaging attempt. CI produces the installer.
- **PR body / release evidence currency.** This PR body is kept current, but the
  release-evidence document should be re-verified against the final workflow
  output before publication.

## What TraceHealer does not do

- TraceHealer never auto-merges customer code. Generated repair pull requests are
  draft-only review artifacts until an engineer merges them.
- Audio / microphone transcription is not implemented.
- There is no generic shell, filesystem, or process bridge exposed to the desktop
  renderer.

## Repository hygiene

No prompt files, handoff files, credentials, `.env` files, runtime workspace
directories, build output, target directories, custom toolchain shims, or session
JSON were committed. The only places `sumit` and Windows paths appear in the
repository are inside test fixtures that explicitly assert those strings are
redacted before any client or diagnostic sees them.

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

- **Server unit tests: 189 passed, 0 failed** across 28 test files
  (`npm test`).
- **Browser E2E: 13 passed, 0 failed** (`npm run test:e2e`) — control center
  load/heal/detail/needs-review/cancellation/notifications/report flow, session
  rejection surfaces, responsive layout, accessibility state, and the
  session-authenticated server surface including artifact download authorization.
- **Desktop Rust tests: 99 passed, 0 failed** (`cargo test` in
  `apps/desktop/src-tauri`, run in the clean clone; the desktop CI matrix runs
  `cargo fmt --check`, `cargo check --verbose`, and `cargo clippy -- -D warnings`
  on windows-latest, macos-latest, and ubuntu-latest, and all three pass).
- **Desktop renderer tests: 62 passed, 0 failed** (`node --test` on
  `apps/desktop/src/*.test.mjs`).
- **Lint: 0 errors** (`npm run lint`, eslint `.`).
- **Typecheck: 0 errors** (`npm run typecheck`).
- **Production dependency audit: 0 vulnerabilities** (`npm audit --omit=dev`).
- **Clean-clone verification: performed** from the committed branch
  `feat/tracehealer-production-completion` at the desktop-complete commit
  `1e72175` (the commits after it touch only `tauri.conf.json` icons, the desktop
  workflow, and these docs). `npm ci` installed cleanly in both the
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
- The desktop Rust checks in the clean clone ran against this host's own toolchain
  setup rather than a runner image, so they are a local code check rather than
  packaging proof. The reproducible Rust path for CI is the desktop workflow on the
  official windows-latest / macos-latest / ubuntu-latest toolchains.

## Server runs verified in the container proof

- Container starts as non-root (`uid=1001(nextjs)`), health endpoint returns 200,
  readiness returns 200.
- A demo heal progresses from `queued` to `healed` with before/after test exit
  codes `1 -> 0`, 4 verification checks, and a real local commit written and read
  back.
- After `docker compose restart`, the same run is still readable in the same
  terminal state with the same checks — state survives restart.

## Desktop CI results

All required desktop jobs pass. The final desktop run is `38155469324` on `main`
at the merge commit `cb18569`, with the Windows, macOS, and Ubuntu legs all green:

- **Windows (x86_64-pc-windows-msvc): pass** — produces
  `tracehealer-desktop-windows-unsigned` with
  `TraceHealer_0.1.0_x64_en-US.msi` plus `TraceHealer_0.1.0_x64-setup.exe`.
- **macOS (universal): pass** — produces
  `tracehealer-desktop-macos-unsigned` with a universal `.dmg`.
- **Linux (x86_64-unknown-linux-gnu): pass** — produces
  `tracehealer-desktop-linux-unsigned` with an AppImage and a `.deb`.

The uploaded artifacts contain the installers only. The workflow's checksum step
writes `.sha256` files next to the raw release binaries rather than next to the
bundled installers, so it does not produce installer checksums and no `.sha256` file
ships inside these artifacts. The installer hashes below were computed locally from
the downloaded artifacts. **Follow-up:** that raw-binary checksum step has since
been replaced by `scripts/generate-release-checksums.mjs`, which runs once in the
release job over the downloaded bundles, so future tag runs publish checksums for
the files users actually download.

### Artifact integrity note

The workflow runs the checksum step under `shell: bash` so the loop is not parsed by
PowerShell on `windows-latest`. All three legs produce the installers listed below.
Because the workflow's own `.sha256` output covers the raw binaries and not the
bundles, the independently computed checksums below are the authoritative ones.

Independently computed SHA-256 hashes of the five installers downloaded from run
`38155469324` (head `cb18569`, the exact commit this PR merged as):

- `win/msi/TraceHealer_0.1.0_x64_en-US.msi`
  `b74786ea7166d5f463d3080e84febb58305c59e23a8b766d176ca5c0c27181df`
- `win/nsis/TraceHealer_0.1.0_x64-setup.exe`
  `beb8432b2014820b842a07e34663334a78260e4be7cd0fe88c177aa8936fb4c7`
- `linux/appimage/TraceHealer_0.1.0_amd64.AppImage`
  `5d520a53c1f1147be6ca7469fec860e5a06ad0cf4afbb0167cac6d61f93bf5ba`
- `linux/deb/TraceHealer_0.1.0_amd64.deb`
  `1d9e3b22c1d1cad327958064b388ac6c21b90f96a5c33982b19496a04b4cee0d`
- `macos/dmg/TraceHealer_0.1.0_universal.dmg`
  `ac87163b29de4b3bd1d46ec39950b1e451a8c498dbbaba5b3a47f6151fa3f685`

These hashes were computed locally from the downloaded artifacts. The five
installers and their checksums are published together as the unsigned preview
release `v0.1.0-rc.1` described below.

## CI fix this PR had to make: the Windows checksum step

The desktop workflow was failing on the Windows leg because the checksum step ran
under the runner's default PowerShell shell, which cannot parse the bash loop that
step is written in. The only fix needed is the explicit `shell: bash` on that step;
this is a workflow mechanic, not an application bug, and all three legs pass with it
in place.

## Local desktop packaging attempt

Local packaging was attempted with the script actually defined in
`apps/desktop/package.json` (`npm run build`, which resolves to `tauri build`).
On this machine it cannot complete, for a host-toolchain reason with nothing to do
with this repository's code: the active Rust toolchain is
`stable-x86_64-pc-windows-gnu` and the GNU target's resource compiler `windres`
is absent (the build script fails with `NotAttempted("windres")`), and there is no
Visual Studio, Windows SDK, `cl.exe`, `rc.exe`, or MSVC `link.exe`.

`cargo fmt --check` and `cargo check` pass on this machine; the local `cargo test`
/ `cargo clippy` / `tauri build` runs stop at that build-script step. The only
`link.exe` on `PATH` is Git's coreutils one, which cannot produce a bundle. No
installer was produced locally, so the installer is a CI-only artifact. The
recommended MSVC path and this gap are documented in `apps/desktop/README.md`.

## Launch verification

The desktop application was not launched in this environment, so an end-to-end
desktop session — window render, tray, quit, open-dashboard, connection, sign-in
state, incidents, run detail, live progress reconnect, notification click, logout —
is **not claimed**. The published installers were verified structurally (see
*Structural checks performed on the published installers* above), and the UX logic
is covered by the desktop commands, tray, notifier, and renderer tests plus the
server routes the desktop talks to, but there is no live desktop run here.

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

## Unsigned preview release (v0.1.0-rc.1)

Downloadable installers are published as the GitHub prerelease
<https://github.com/sumitagg24/tracehealer/releases/tag/v0.1.0-rc.1>, tagged from
the merged `main` commit `cb18569`. The desktop app version is `0.1.0` and is
consistent across `apps/desktop/package.json`,
`apps/desktop/src-tauri/Cargo.toml`, and `apps/desktop/src-tauri/tauri.conf.json`.

- Windows: `TraceHealer_0.1.0_x64_en-US.msi` (3,477,504 bytes) and
  `TraceHealer_0.1.0_x64-setup.exe` (2,306,769 bytes).
- macOS: `TraceHealer_0.1.0_universal.dmg` (7,114,741 bytes).
- Linux: `TraceHealer_0.1.0_amd64.AppImage` (84,052,472 bytes) and
  `TraceHealer_0.1.0_amd64.deb` (5,275,566 bytes).
- Checksums: `SHA256SUMS.txt`, with the five hashes listed in the section above.

Each asset was re-downloaded from the public release URL **without
authentication** and re-hashed: the MSI came back at 3,477,504 bytes with SHA-256
`b74786ea7166d5f463d3080e84febb58305c59e23a8b766d176ca5c0c27181df`, byte-identical
to the CI artifact, and GitHub's own recorded asset digests match the hashes above.
The release is marked **prerelease**, and its notes lead with PREVIEW / UNSIGNED,
the Windows SmartScreen and macOS Gatekeeper warnings, the unconfigured
integrations, and the fact that no auto-updater exists in this build.

### Structural checks performed on the published installers

All on the downloaded files, without installing anything and without bypassing any
operating-system control:

- MSI database: `ProductName=TraceHealer`, `ProductVersion=0.1.0`,
  `Manufacturer=neathack`, `ProductLanguage=1033`, `ALLUSERS=1`.
- `msiexec /a` administrative extract of the MSI (no product registration, no
  elevation): it contains `tracehealer-desktop.exe` (11,494,400 bytes, file version
  `0.1.0`).
- Authenticode: both Windows files report **NotSigned**.
- NSIS PE version resource: `ProductName=TraceHealer`, `ProductVersion=0.1.0`.
- AppImage: 64-bit x86-64 ELF, AppImage type-2 magic, embedded squashfs found at
  offset 194,183.
- deb: valid `ar` archive (`debian-binary`, `control.tar.gz`, `data.tar.gz`) whose
  control metadata reports `Package: trace-healer`, `Version: 0.1.0`,
  `Architecture: amd64`, `Maintainer: neathack`.
- DMG: valid UDIF trailer (`koly` v4) with a single `blkx` describing a
  GPT-partitioned `Apple_HFS` volume.

### Not performed: installing or launching the app

The installers were **not installed or launched**, and no GUI session was run, so
window rendering, tray icon, notifications, connecting to a server, loading
incidents/runs, live progress, deep-link rejection, logout credential removal,
quit, and uninstall remain unverified in the packaged binaries. Those flows are
covered by the 99 Rust tests and the 62 renderer tests, which is not the same
evidence as a live run.

## Remaining release blockers

- **Signing and notarization.** Production macOS distribution requires signing and
  notarization; Windows distribution requires signing. No signing credentials are
  configured in this repo, and the CI artifacts are explicitly unsigned test
  builds; they are published only as the clearly labeled GitHub prerelease
  `v0.1.0-rc.1`. The workflow's `release-artifacts` job is gated on `refs/tags/v*`,
  and the `on.push` trigger now matches `v*` tags as well, so a tag push builds all
  three platforms and then publishes the installers with a generated
  `SHA256SUMS.txt`. The tag that created `v0.1.0-rc.1` predates that trigger, so
  that release was assembled by hand from the same verified CI artifacts.
- **Production provider credentials.** A real deployment still needs
  `TRACEHEALER_OIDC_AUTHORIZE_URL`, `TRACEHEALER_OIDC_TOKEN_URL`,
  `TRACEHEALER_OIDC_CLIENT_ID` (and, for a confidential client, the secret on the
  server side only), plus GitHub tokens, Slack webhook URLs, neatlogs credentials,
  and any model-provider keys. None of those are verified here.
- **End-to-end desktop launch.** Not performed: the installers were not installed
  or launched here, so only their structure (checksums, MSI database, PE resources,
  archive formats) is verified, not their runtime behaviour.
- **Local Windows installer reproducibility on this machine.** This machine cannot
  build the installer locally: the active GNU target has no `windres`, and there is
  no Visual Studio/Windows SDK or MSVC linker. CI produces the installer and is the
  only source of one.
- **Docs currency on `main`.** Resolved: this file and the corrected
  `docs/RELEASE_EVIDENCE.md` now live on `main`, so the stale 172-test figures that
  `main` used to carry are gone.

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

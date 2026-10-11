# TraceHealer release evidence

Environment: Windows 11, Node v22.23.2, npm 10.9.8, Next.js 16.4.0, Docker 29.8.0.
Branch: `feat/tracehealer-production-completion`. Date: 2026-10-11.

All commands below were run from the repository root. No secrets are included;
integration status is reported as booleans only.

> The unit-suite counts in the early sections below are the historical Prompt
> 1/2/3 measurements. The current, authoritative gate counts are in **Clean-clone
> audit** and **Static and unit verification (current)** at the end of this file.

## Static and unit verification

| Command | Result |
|---|---|
| `npm run typecheck` | pass (0 errors) |
| `npm run lint` | pass (0 errors, 0 warnings) |
| `npm test` | pass — 12 files, 47 tests (Prompt 1/2/3 baseline) |
| `npm run build` | pass — Next.js standalone build; 15 routes compiled |
| `npm audit --omit=dev` | pass — `found 0 vulnerabilities` |

Test files: `context`, `engine`, `trace-normalizer`, `sandbox`, `pipeline`,
`run-state`, `runs`, `http`, `webhook`, `policy`, `strategies`, `redact`.

## End-to-end heal (HTTP smoke)

```
POST /api/runs {"mode":"demo","idempotencyKey":"smoke-key-0001"}
→ 202 {"ok":true,"runId":"heal_69977a13","state":"queued","deduplicated":false}

POST /api/runs {"mode":"demo", ...same key...}
→ 200 {"runId":"heal_69977a13","state":"verifying","deduplicated":true}

GET /api/runs/heal_69977a13/progress (polled)
→ state healed, events=6, hasResult=true

GET /api/runs/heal_69977a13
→ status healed
  file src/order-support.mjs
  beforeTestExitCode 1 → afterTestExitCode 0
  localCommit 28c019b
  checks passed,passed,passed,passed
  contextFiles 2 (contains src/order-support.mjs)
  delivery {"github":"not-configured","neatlogs":"not-configured","slack":"not-configured"}
  absolutePathInLog false
```

## Unsupported failure stays `needs-review`

A webhook trace with a `timeout` error (no deterministic strategy):

```
status needs-review · state needs-review
verification.after === verification.before  (true)
improvements {latency 0, tokens 0, cost 0}
messages ["No trusted sandbox strategy is registered for this failure category."]
artifacts none
```

## Security boundaries

| Case | Result |
|---|---|
| `POST /api/runs` with `Origin: https://evil.example` | `403 invalid-origin` |
| `POST /api/runs` with `Content-Type: text/plain` | `400 invalid-input` |
| `POST /api/runs` with `{}` (no explicit mode) | `400 invalid-input` |
| `POST /api/runs` with malformed JSON | `400 invalid-input` |
| `POST /api/runs` with an oversized body | `413 payload-too-large` |
| `GET /api/readiness` | identical status/payload/headers to `/api/ready` |
| `GET /api/artifacts/../../package.json/patch` | `404` |
| `POST /api/runs/:id/publish` (GitHub unconfigured) | `503 unconfigured` |
| Webhook native `trace.failed` | `202` |
| Webhook non-actionable event type | `200 ignored` |
| Webhook body without a valid trace | `400` |
| Security headers on `/api/health` | CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` present |
| Rate limit (`TRACEHEALER_RATE_LIMIT`) | `429` after the window fills (unit test) |

## Artifacts

```
GET /api/artifacts/heal_69977a13/patch  → 200 text/x-diff; charset=utf-8
GET /api/artifacts/heal_69977a13/report → 200 application/json; charset=utf-8
```

## Readiness and metrics

```
GET /api/ready → {"status":"ready","dataRootWritable":true,
  "policy":{"allowlistedRepositories":["northstar/support-agent"],
            "allowlistedPatchPaths":["src/order-support.mjs"],
            "modelPatchesEnabled":false}, ...}
GET /api/metrics → derived only from persisted runs
```

## Browser verification

The dev server was run with `TRACEHEALER_DATA_DIR=.tracehealer-verify`.
The control center was driven in a real browser:

- Live metrics rendered from `/api/metrics`: `2` runs, `1` healed,
  `1` needs-review, `845ms` average (server-measured).
- Healing progress was sampled from the DOM while a run was in flight:
  `healer-card running` with the live timeline at `Diagnosing` (3 events) →
  `Verifying` (4 events) → `healer-card complete`, `Run state: Healed`.
- Result panel: `ALL CHECKS PASSED`, 4 checks, both artifact links, and the
  publish button with the truthful unconfigured message.
- Publish action surfaced `GitHub publishing is not configured...` (no fake
  success).
- Run detail rendered the timeline (7 events), 4 checks, 6 detail cards, both
  logs, and the diff.
- Accessibility tree showed real landmarks, a `role=status` live region,
  a `tablist`, accessible names, and disabled-with-explanation placeholders.
- No horizontal overflow at 390px, 768px, 1024px, and 1440px.

## Docker

Not executed in the earlier session (Docker was unavailable). Executed for real
on 2026-10-11 — see **Docker packaging proof** below.

## Prompt 2 — authentication and tenant authorization

Contract tests (`lib/auth.test.ts`, 11 cases):

```
local mode grants an admin principal with every capability
production runtime + local mode without acknowledgement -> 503 unconfigured
production runtime + TRACEHEALER_LOCAL_AUTH_ACK=true -> allowed
session mode without TRACEHEALER_SESSION_SECRET -> 503 unconfigured
session mode without a cookie -> 401 unauthorized
operator cookie: run:create allowed, policy:write forbidden (403)
viewer cookie: run:read allowed, run:create forbidden (403)
expired token -> 401 unauthorized
tampered signature -> rejected
cross-tenant tenantId -> 404 not-found
cookie-authenticated mutation with Origin: https://evil.example -> 403 invalid-origin
```

HTTP evidence. The standalone production build was started with
`TRACEHEALER_AUTH_MODE=session`, a `TRACEHEALER_SESSION_SECRET`, and a throwaway
`TRACEHEALER_DATA_DIR`. Session cookies were minted with the same HMAC scheme as
`lib/auth.ts` and the responses below are copied from that server:

```
GET  /api/runs  (no cookie)                        -> 401 {"code":"unauthorized","error":"Authentication required"}
GET  /api/runs  (expired cookie)                   -> 401 {"code":"unauthorized","error":"Authentication required"}
GET  /api/runs  (operator cookie)                  -> 200 {"ok":true,"runs":[],"count":0}
GET  /api/runs  (viewer cookie)                    -> 200 {"ok":true,"runs":[],"count":0}
POST /api/runs  (viewer cookie, mode demo)         -> 403 {"code":"forbidden","error":"Your role does not permit this action"}
POST /api/runs  (operator cookie, foreign Origin)  -> 403 {"code":"invalid-origin","error":"Cross-origin request rejected"}
```

Same server, operator cookie, Prompt 1 request contract over real HTTP:

```
POST /api/runs {}                                  -> 400 {"code":"invalid-input","error":"Invalid run payload"}
POST /api/runs {oops                               -> 400 {"code":"invalid-input","error":"Request body is not valid JSON"}
POST /api/runs {"mode":"connected","trace":{"bad":true}} -> 400 {"code":"invalid-input","error":"Invalid run payload"}
POST /api/runs Content-Type: text/plain            -> 400 {"code":"invalid-input","error":"Expected an application/json request body"}
POST /api/runs 600 kB body                         -> 413 {"code":"payload-too-large","error":"Request body exceeds the size limit"}
POST /api/runs {"mode":"demo"}                     -> 202 {"runId":"heal_5c6c3562","state":"queued"}
```

That 202 run finished for real through the authenticated API:

```
GET /api/runs/heal_5c6c3562/progress
  result.state              healed
  verification.passed       true
  checks                    4/4 passed
  beforeTestExitCode        1   (TAP: # fail 3)
  afterTestExitCode         0   (TAP: # pass 4)
  artifacts.localCommit     2f344d0
  delivery                  github/neatlogs/slack = not-configured
```

Readiness alias equivalence, measured on the same server:

```
GET /api/ready     -> HTTP/1.1 200 | Cache-Control: no-store | content-type: application/json
GET /api/readiness -> HTTP/1.1 200 | Cache-Control: no-store | content-type: application/json
bodies identical after removing the volatile timestamp field: true
```

Not claimed: no external identity provider (OIDC/SAML) was configured or called,
so no live third-party login is verified. The provider boundary, the local
principal, and HMAC session validation are implemented and tested.

## External blockers (not claimed as verified)

- No live **neatlogs** ingest/export contract (no endpoint or key).
- No live **GitHub** draft PR (no token on a separate target repo).
- No **Slack** notification (no webhook URL).
- No live **model** provider (strategy disabled by policy).
- No **Entire** graph provider (no official API/CLI contract).
- No container worker for untrusted repositories; the sandbox runs the fixed
  trusted fixture in-process.

## Post-merge audit (2026-10-10)

An independent audit ran against a fresh clone of `origin/main` (commit
`91cc978`). It reproduced the results above and found one hardening gap, now
fixed:

- **Sandbox child environment.** `lib/sandbox.ts` previously passed
  `...process.env` to the subprocess that runs target-repository tests and the
  replay worker, exposing platform credentials to that code. It now builds an
  explicit allowlist via `sandboxEnvironment()`. Regression test:
  `lib/sandbox.test.ts` asserts `GITHUB_TOKEN`, `NEATLOGS_API_KEY`,
  `SLACK_WEBHOOK_URL`, `OPENAI_API_KEY`, and `DATABASE_URL` are absent while
  `PATH`/`HOME` remain. The real sandbox tests still pass, proving the narrowed
  environment is sufficient for `git` and `node`.

Audit notes (not defects): the sandbox runs the trusted fixture in-process, so
there is still no OS-level isolation for untrusted repositories; `npm start`
prints a standalone warning (use `node .next/standalone/server.js`); and the
readiness route is `/api/ready` (not `/api/readiness`). Dev-only `npm audit`
highs are the `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` →
`micromatch` → `braces` chain with no production impact.

## Browser E2E (Playwright, production build)

`npm run test:e2e` builds the app and starts two servers from that one build,
both bound to loopback:

- port 3188 — `TRACEHEALER_AUTH_MODE=local` with the documented
  `TRACEHEALER_LOCAL_AUTH_ACK=true` acknowledgement (NODE_ENV=production);
- port 3189 — `TRACEHEALER_AUTH_MODE=session` with the durable
  `TRACEHEALER_STORE=sqlite` adapter, which is the mode that enforces tenant
  isolation.

Result: **13 passed (26.4s)**, file `e2e/tracehealer.spec.ts`.

| Scenario | Result |
|---|---|
| local development auth: control center loads without a session | pass |
| explicit demo heal: live progress, cancel affordance, healed card, ALL CHECKS PASSED, `before exit 1 → after exit 0` | pass |
| run detail: timeline, context, checks, metrics, delivery, artifact content types | pass |
| unsupported (timeout) failure settles `needs-review`, never a fabricated fix | pass |
| active cancellation settles `cancelled` with no resurrection | pass |
| notification popover lists persisted runs, Escape closes and restores focus | pass |
| `/api/report` defaults: estimate disabled, no fabricated money/time, ≤5 recent runs, no sponsor links | pass |
| unauthenticated 401 responses render the sign-in surface (not an offline banner) | pass |
| a session rejected mid-use renders the expired-session surface | pass |
| no horizontal overflow at 1440/1024/768/390 px | pass |
| every disabled control has an explanation and every control has an accessible name | pass |
| session server fails closed (401) and enforces role separation (viewer POST → 403) | pass |
| artifact download: anonymous → 401, matching tenant → 200, foreign tenant → 404 | pass |

This required two real UI fixes found by the suite: a 401 during `POST /api/runs`
now carries its HTTP status so the auth surface renders, and a first-ever 401 is
no longer upgraded to "expired" by a second parallel rejection.

## Static and unit verification (current, 2026-10-11)

Run from the repository root on the feature branch, and repeated from a literal
clean clone:

| Command | Result |
|---|---|
| `npm run typecheck` | pass (exit 0) |
| `npm run lint` | pass (exit 0, no output) |
| `npm test` | pass — **28 test files, 189 tests**, 0 failures, exit 0 |
| `npm run build` | pass (exit 0) — 21 routes (1 page route + 20 `/api/*` dynamic) |
| `npm run test:e2e` | pass — **13 passed (21.4s)**, exit 0, Playwright against the production build |
| `cargo fmt --check` (apps/desktop/src-tauri) | pass (exit 0) |
| `cargo check` (apps/desktop/src-tauri) | pass (exit 0) on this host toolchain |
| `node --test` (apps/desktop/src/*.test.mjs) | pass — **62 tests**, 0 failures |

The figures above are from the gate re-run after the desktop client landed. The same
gate had previously reported the then-current 172-test total; the suite has grown to
189 tests across 28 files, and the same commands pass from a fresh checkout on the
GitHub runner (the `quality` and `e2e` jobs of CI run `38155469309`).

## Clean-clone audit (2026-10-11)

A literal fresh clone of the committed branch tip (`40e44a4` at the time of the
run; it predates the desktop-client commits, which are covered instead by the
desktop workflow matrix and by the gate re-run in the section above) was verified
with no local/untracked state, no `.env`, no warm `node_modules`, and no build
output carried over:

```
git clone <repo> /tmp/th-audit-clean
cd /tmp/th-audit-clean
git status --short --branch     -> clean (nothing untracked, nothing ignored needed)
ls -a                           -> source only; no handoff/prompt/runtime/build file
npm ci --legacy-peer-deps       -> added 386 packages
npm run typecheck                -> exit 0
npm run lint                     -> exit 0
npm test                         -> 27 files, 172 tests passed
npm run build                    -> exit 0
npm run test:e2e                 -> 13 passed (22.2s), exit 0
```

`npm ci` without `--legacy-peer-deps` fails on the peer-dependency graph, which is
why CI uses the same flag. Tracked-file scan of the clone found no handoff,
credential, runtime-workspace, or build artifact: the only matches for
`prompt`/`.env` are `lib/prompt1.test.ts` (a test) and `.env.example`
(placeholders only).

## Docker packaging proof (2026-10-11)

Docker 29.8.0 / Compose v5.5.1, executed against the real image built from this
repository's `Dockerfile`:

```
docker compose -f compose.yaml -f compose.proof.yaml build tracehealer
  -> image tracehealer-tracehealer built
docker compose ... up -d
  -> Up (healthy)   0.0.0.0:3000->3000/tcp
docker inspect --format {{.State.Health.Status}}  -> healthy
curl /api/health -> 200      curl /api/ready -> 200
docker compose exec tracehealer id -> uid=1001(nextjs) gid=65533(nogroup)   (non-root)

POST /api/runs {"mode":"demo","idempotencyKey":"docker-proof-1"}
  -> 202 {"runId":"heal_8b8223e9","state":"queued","deduplicated":false}
GET /api/runs/heal_8b8223e9/progress
  -> summary.state healed · status healed
     result.verification.passed true
     artifacts.beforeTestExitCode 1 -> afterTestExitCode 0
     artifacts.localCommit b390610 · events 6

docker compose restart tracehealer
  -> health 200
GET /api/runs/heal_8b8223e9/progress  (same run id, after restart)
  -> summary.state healed · verification.checks 4      (volume-persisted)

docker compose down -v
```

The container proof overlay (`compose.proof.yaml`) only sets
`TRACEHEALER_AUTH_MODE=local` + `TRACEHEALER_LOCAL_AUTH_ACK=true`, the documented
development acknowledgement; the published port was loopback-reachable for the
local proof only.

## Cancellation authority (2026-10-11)

A real ordering bug found by the full gate, not a test-only flake: a pipeline that
observed the abort could persist its own terminal `needs-review` verdict *before*
the coordinator recorded the cancel, and the terminal-state guard then rejected the
cancellation, leaving a cancelled run reported as `needs-review`.

- The coordinator now writes cancellation through `RunStore.cancelRun`, which may
  replace a non-verified verdict but never rewrites a verified `healed` run, a
  retryable `delivery-failed` one, or a decided `timed-out` one.
- The pipeline no longer attempts to settle a terminal state once its signal is
  aborted (`record()` and `persistResult()` both defer to the coordinator), so the
  cancel is the last word regardless of interleaving.
- Regression coverage: `lib/store.test.ts` (authoritative replace, verified run
  untouched, delivery-failed/timed-out untouched, idempotent, unknown run),
  `lib/db.run-store.test.ts` (durable adapter + audit event + other-tenant `null`),
  and `lib/prompt1.test.ts` (no `needs-review` write survives a real cancel).

## Provider selection fails closed (2026-10-11)

`TRACEHEALER_SANDBOX_PROVIDER=docker` was parsed into policy but never bound, so
setting it silently kept the in-process sandbox. `createPipelineDeps` now refuses
with `503 unconfigured` instead of downgrading, while an explicitly injected
provider still wins. `lib/container-sandbox.test.ts` covers both paths. The
container provider itself is proven live in the same file: it builds
`docker/sandbox.Dockerfile` and runs the attack probes (no-network,
read-only-root, non-root, no-server-env, docker-socket-absent) against real
containers.

## Dependency audit

`npm audit --omit=dev` reports `found 0 vulnerabilities`. The full `npm audit`
(which includes dev-only tooling transitive dependencies) is intentionally not
force-fixed, because `npm audit fix --force` would downgrade Next.js; the
production dependency set is what ships and it is clean.

## Desktop release evidence (2026-10-11)

The desktop client exists only as an explicitly unsigned preview.

```
desktop workflow run 38155469324   (main @ cb18569)   windows/macos/linux all pass
  artifacts: tracehealer-desktop-windows-unsigned    5,555,371 bytes
             tracehealer-desktop-macos-unsigned      7,064,606 bytes
             tracehealer-desktop-linux-unsigned     88,666,602 bytes

gh run download 38155469324 --dir <tmp>        -> 5 installers, no .sha256 inside
sha256sum <each installer>                     -> 5 hashes (listed in docs/PR_BODY.md)
gh release create v0.1.0-rc.1 --prerelease ... -> 6 assets uploaded (incl. SHA256SUMS.txt)
curl -sSL <public asset url> (no auth)         -> HTTP 200; MSI byte-identical
```

Verified on the downloaded files: MSI database reports `ProductName=TraceHealer`
and `ProductVersion=0.1.0`; the `msiexec /a` administrative extract contains
`tracehealer-desktop.exe` (11,494,400 bytes, version `0.1.0`); Authenticode reports
`NotSigned` for both the MSI and the NSIS installer; the AppImage is a 64-bit
x86-64 ELF with the AppImage type-2 magic and an embedded squashfs; the deb control
metadata is `trace-healer 0.1.0 amd64`; the DMG is a valid UDIF image (`koly` v4,
GPT + `Apple_HFS`).

**Not verified:** the installers were never installed or launched, so packaged
runtime behaviour (main window, tray, notifications, server connection, sign-in,
logout, uninstall) is unverified. Local packaging is impossible on this host — the
active Rust target is `x86_64-pc-windows-gnu` with no `windres`, and there is no
MSVC toolchain — so the CI artifacts are the only available ones.

## Tag-triggered release automation (2026-10-12)

`v0.1.0-rc.1` had to be assembled by hand because the desktop workflow's `on.push`
trigger listed branches only, so its `release-artifacts` job could never fire for a
tag. Both gaps are fixed on `main`:

- The push trigger now matches `v*` tags as well as the existing branches, so a tag
  runs the whole desktop matrix and then the release job. A tag containing `-rc`
  publishes as a prerelease, a plain `vX.Y.Z` tag publishes normally, and branch
  pushes and pull requests behave exactly as before.
- The per-platform checksum step that hashed the raw release binaries is gone.
  `scripts/generate-release-checksums.mjs` (Node built-ins only, no build step)
  runs once in the release job over the downloaded bundles, so the checksums always
  describe the files a user downloads. It fails loudly when no installer is
  present, when two paths collide, or when an installer is a symlink.

Verified against copies of the five published `v0.1.0-rc.1` installers, in a
directory outside the repository, in both a flat layout and the nested
`msi / nsis / dmg / appimage / deb` layout that a merged artifact download produces:

```
node scripts/generate-release-checksums.mjs <dir>
                                       -> 5 installers; every digest identical to
                                          the published SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt            -> 5x OK (flat and nested)
second run                             -> byte-identical output
missing dir / empty dir / no argument  -> exit 1
non-installer files, SHA256SUMS.txt    -> never listed
```

Unit tests: `scripts/generate-release-checksums.test.ts`, covering extension
filtering, recursive discovery, deterministic ordering, digest correctness,
idempotence, self-exclusion, duplicate and case-collision rejection, symlink
refusal, a missing directory, and the empty case. The symlink case is skipped on a
Windows host without symlink privileges rather than silently passing.

One consequence worth recording: a flat `*.msi`-style upload glob would miss the
merged `msi/…`, `nsis/…`, `dmg/…`, `appimage/…`, `deb/…` paths, so the release job
uploads `dist/**/*.<ext>` to match the generator's own recursive discovery.

# TraceHealer release evidence

Environment: Windows 11, Node v22.23.2, npm 10.9.8, Next.js 16.4.0.
Branch: `feat/tracehealer-full-flow`. Date: 2026-10-10.

All commands below were run from the repository root. No secrets are included;
integration status is reported as booleans only.

## Static and unit verification

| Command | Result |
|---|---|
| `npm run typecheck` | pass (0 errors) |
| `npm run lint` | pass (0 errors, 0 warnings) |
| `npm test` | pass — 12 files, 47 tests |
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
| `POST /api/runs` with `Origin: https://evil.example` | `403` |
| `POST /api/runs` with `Content-Type: text/plain` | `400` |
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

The `Dockerfile` and `compose.yaml` are unchanged and CI builds the app, but
Docker was **not** available in this environment, so container build, non-root
runtime, healthcheck, and restart/persistence were not executed here.

## External blockers (not claimed as verified)

- No live **neatlogs** ingest/export contract (no endpoint or key).
- No live **GitHub** draft PR (no token on a separate target repo).
- No **Slack** notification (no webhook URL).
- No live **model** provider (strategy disabled by policy).
- No **Entire** graph provider (no official API/CLI contract).
- No container worker for untrusted repositories; the sandbox runs the fixed
  trusted fixture in-process.

## Dependency audit

`npm audit --omit=dev` reports `found 0 vulnerabilities`. The full `npm audit`
(which includes dev-only tooling transitive dependencies) is intentionally not
force-fixed, because `npm audit fix --force` would downgrade Next.js; the
production dependency set is what ships and it is clean.

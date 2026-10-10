# TraceHealer implementation status

Last verified: 2026-10-10 · Branch `feat/tracehealer-full-flow`

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
| Cancellation / timeout / stale recovery | `lib/runs.ts` coordinator | `lib/runs.test.ts` | Cancellation is cooperative, not mid-subprocess | verified (cooperative) |
| Atomic persistence | per-path write serialization + rename retry | `lib/runs.test.ts` (found and fixed a real Windows EPERM race) | Single-process only | verified |
| Server-driven UI progress | `POST /api/runs` + polling `/api/runs/:id/progress` | browser sample: Diagnosing → Verifying → Healed | Polling not SSE | verified |
| UI lifecycle states | loading/empty/error/offline/queued/running/needs-review/delivery-failed/cancelled/timed-out/healed | browser a11y tree + DOM probes | None found | verified |
| Run detail view | timeline, context, checks, metrics, delivery, artifacts, logs, diff | browser DOM probe (7 events, 4 checks, 6 cards) | None found | verified |
| Accessibility | landmarks, `role=status` live region, tablist, accessible names, reduced motion, focus-visible | a11y tree; widths 390/768/1024/1440 without overflow | Contrast not audited with a tool | implemented |
| Dead controls removed | unavailable search/notifications/workspace-switcher are disabled with explanations; copy/filters/nav work | browser DOM probes | None found | verified |
| Security hardening | same-origin (403), content-type (400), size limits, rate limit (429), CSP + headers | `lib/http.test.ts`, HTTP smoke | Limits are per-process, in-memory | verified |
| Webhook auth | constant-time HMAC, timestamp tolerance, replay guard | `lib/webhook.test.ts`, HTTP smoke (202/400) | Live neatlogs contract unverified | verified (contract) |
| Secret/PII redaction | `lib/redact.ts` applied to logs and model context | `lib/redact.test.ts`, smoke (`absolutePathInLog: false`) | Pattern-based, not exhaustive | verified |
| Sandbox env isolation | `sandboxEnvironment()` forwards only operational variables to child processes | `lib/sandbox.test.ts` | Still no OS-level container boundary | verified |
| Model patch strategy | `createModelStrategy` strict JSON, policy-gated, off by default | `lib/strategies.test.ts` adversarial cases | Live model provider unverified | implemented |
| Readiness + metrics | `/api/ready`, `/api/metrics` derived from persisted runs | HTTP smoke | None found | verified |
| Repository context (local graph) | `lib/context.ts` scans the target fixture for files/symbols/tests | pipeline test | Only JS/TS-shaped files | verified |
| Real remote repository checkout | Not implemented; the target is the local fixture | — | Needs clone/commit pinning + container isolation | blocked (design) |
| Untrusted-code container boundary | Not implemented; local process provider only | — | Arbitrary third-party code must run in a disposable container | blocked (design) |
| Multi-tenant authorization | Single-tenant local deployment | — | Needs auth + ownership scoping | blocked (design) |
| GitHub draft delivery | `lib/github.ts` draft-only, idempotent, policy-gated | code review + typed error smoke (503 unconfigured) | No live draft PR (no credentials) | blocked (credentials) |
| After-trace export / Slack | Configurable adapters, failures isolated from verification | pipeline code path | No live provider (no credentials) | blocked (credentials) |
| Dodo / AWS / CFO sponsor adapters | Not implemented | — | Requires official docs + contracts | out of scope |
| Docker packaging | `Dockerfile` + `compose.yaml` present | CI builds the app | Not built/run in this environment (no Docker) | unverified here |

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

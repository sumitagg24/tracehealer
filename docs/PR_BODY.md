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

1. Incoming payloads cannot select commands or filesystem paths.
2. The observed failure must reproduce (non-zero exit and a failed replay)
   before any source is changed.
3. No failed verification can commit or publish.
4. Only a reproduced, fully verified run can publish; publication is draft-only.
5. Unsupported failures return `needs-review` with zero fabricated improvement.
6. Generated customer repair PRs are **never** auto-merged.
7. Secrets, tokens, absolute paths, and raw authorization headers never reach the
   browser or artifacts.

## Feature summary

- Provider interfaces, DI registry, typed errors
- Run state machine, audit events, idempotency, cancellation, timeout, recovery
- Policy allowlists, protected paths, command allowlist, config validation
- Security: origin/CSRF, size, rate limit, webhook replay, redaction, CSP
- Liveness/readiness/metrics endpoints; async runs + progress polling
- Rebuilt operations console with run detail and all lifecycle states
- Expanded test suite (12 files, 47 tests) including adversarial patch cases

## API / UI changes

- `POST /api/heal` remains synchronous and now supports `idempotencyKey`.
- New: `POST /api/runs` (202), `GET /api/runs/:id/progress`,
  `POST /api/runs/:id/cancel`, `GET /api/ready`, `GET /api/metrics`.
- `GET /api/runs` and `GET /api/runs/:id` are additive (`apiVersion`).
- `POST /api/runs/:id/publish` rejects non-verified runs and returns
  `503 unconfigured` when GitHub is not configured.
- `HealResult` is backward compatible: `state`, `events`, `correlationId`, and
  `idempotencyKey` are additive optional fields.

## Test evidence

- `npm run typecheck`, `npm run lint`, `npm test` (47 tests), `npm run build`
  all pass; `npm audit --omit=dev` reports `found 0 vulnerabilities`.
- Full heal smoke: before exit `1` → after exit `0`, 4/4 checks, local commit,
  artifacts readable, no absolute paths in logs.
- Browser: server-driven states observed live (Diagnosing → Verifying →
  Healed); run detail, artifact links, and the unconfigured publish message
  verified; widths 390/768/1024/1440 without overflow.
- See `docs/RELEASE_EVIDENCE.md` for commands and outputs.

## Migration / deployment notes

- All new configuration is optional; the zero-secret flow is unchanged.
- New `TRACEHEALER_*` policy, limit, and webhook variables are documented in
  `.env.example` with safe defaults.
- `docs/ARCHITECTURE.md` and `docs/OPERATIONS.md` describe the provider
  boundaries, states, and endpoints.

## Known external prerequisites

- **neatlogs**: ingest endpoint, signature contract, API key.
- **GitHub**: fine-grained token (or App installation token) on a separate
  target repository.
- **Slack**: webhook URL.
- **Model strategy**: provider key plus `TRACEHEALER_ALLOW_MODEL_PATCHES=true`.
- **Container isolation** for untrusted customer repositories (not implemented;
  the sandbox runs the trusted fixture in-process).

## No-auto-merge guarantee

TraceHealer creates **draft** pull requests for generated customer repairs and
never merges them. Human review and branch protection remain authoritative.

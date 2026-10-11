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
- Authenticated workspace: roles (`viewer`/`operator`/`admin`), tenant-scoped
  reads and writes, fail-closed production auth, and sign-in/unauthorized/
  expired-session surfaces
- Durable distributed adapter (sqlite): runs, transitions, audit events,
  idempotency, webhook replay, queue, rate limit, artifacts
- Notifications and outcome reporting (`/api/report`, plus an in-app notification
  feed derived from persisted runs — no fabricated values)
- Hardened container sandbox provider with a live isolation proof, and a
  fail-closed selection guard so `TRACEHEALER_SANDBOX_PROVIDER=docker` can never
  silently downgrade to the in-process sandbox
- Tauri 2 desktop client (tray, notifications, deep links, OS-keychain session
  vault) with its own policy tests and a windows/macos/linux CI matrix
- Expanded test suite (27 files, 172 tests) including adversarial patch cases and
  a 13-case Playwright browser suite

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

- `npm run typecheck` (0 errors), `npm run lint` (0 findings), `npm test`
  (**27 files, 172 tests**, 0 failures — repeated 4× with no flake), and
  `npm run build` (19 routes) all pass; `npm audit --omit=dev` reports
  `found 0 vulnerabilities`.
- **Clean-clone audit.** The same gates were re-run from a literal fresh clone of
  this branch (no warm `node_modules`, no `.env`, no build output): typecheck,
  lint, 172 unit tests, build, and the browser suite all passed there too.
- **Browser E2E (Playwright).** `npm run test:e2e` builds once and runs two
  servers from that build — a local-development-auth server and a
  session+sqlite server — covering live progress, run detail, unsupported
  failures staying `needs-review`, cancellation, notifications, the report
  endpoint, 401/expired-session surfaces, responsive breakpoints, accessible
  names, role separation, and tenant-scoped artifact access: **13 passed**.
- **Docker packaging.** The real image was built and run: healthcheck `healthy`,
  non-root `uid=1001`, `/api/health` and `/api/ready` 200, a real demo heal inside
  the container (`healed`, before exit 1 → after exit 0, local commit), and the
  run still readable after `docker compose restart`.
- **Container isolation.** A live test builds `docker/sandbox.Dockerfile` and runs
  the attack probes against real containers (no network, read-only root, non-root,
  no credential forwarding, no Docker socket).
- Full heal smoke: before exit `1` → after exit `0`, 4/4 checks, local commit,
  artifacts readable, no absolute paths in logs.
- See `docs/RELEASE_EVIDENCE.md` for commands and verbatim outputs, and
  `docs/IMPLEMENTATION_STATUS.md` for the per-capability verified/blocked matrix.

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
- **Container isolation for untrusted repositories.** The hardened provider and
  its live isolation proof exist, but it is **not bound to the pipeline yet**:
  `TRACEHEALER_SANDBOX_PROVIDER=docker` fails closed with `503 unconfigured`
  rather than downgrading, and the default pipeline still runs the trusted
  fixture in-process.
- **Desktop signing/notarization.** Windows/macOS/Linux installers are produced by
  the `desktop` workflow as **unsigned test builds** until signing credentials and
  (for macOS) notarization are configured.

## No-auto-merge guarantee

TraceHealer creates **draft** pull requests for generated customer repairs and
never merges them. Human review and branch protection remain authoritative.

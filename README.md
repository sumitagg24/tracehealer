# TraceHealer

> **Failure trace → reproduced bug → repository context → minimal patch → sandbox verification → review-ready draft**

TraceHealer is an autonomous incident-response system for production AI agents. It turns structured runtime evidence into a tested software change while keeping publication and merge behind explicit safety gates.

The included neatHack scenario is fully executable: Order API v3 moves a customer email field, a support agent crashes and retries three times, and TraceHealer reproduces the failure, repairs the target in an isolated workspace, runs four regressions, commits the verified fix locally, persists the evidence, and optionally delivers a draft GitHub PR and after-trace.

## Complete working flow

1. **Intake** — native TraceHealer JSON, wrapped neatlogs events, or OTLP JSON enters through a validated API/webhook.
2. **Reproduce** — the target repository fixture is copied to a unique workspace; the original tests and failed production replay must fail as expected.
3. **Diagnose** — TraceHealer selects the actionable error span, classifies it, extracts the stack frame, and builds a local repository context graph.
4. **Patch** — a one-file compatibility repair is applied to the isolated checkout.
5. **Verify** — the exact failed payload, legacy contract, current contract, and typed-error behavior run through `node --test`.
6. **Commit** — only a green repair is committed in the workspace; a real git patch and machine-readable report are saved.
7. **Persist** — the run, logs, metrics, context, commit, delivery state, and artifact paths are atomically recorded.
8. **Deliver** — when configured, TraceHealer exports the verified run, sends Slack evidence, and creates a **draft** GitHub PR. It never merges.

No secret is required for steps 1–7.

## Features

- Production-style control center, incident queue, trace waterfall, diagnosis, diff review, healing runs, evaluations, repositories, and integration pages
- Deterministic classifiers for schema drift, malformed JSON, timeouts, rate limits, and unknown application errors
- Native and OTLP trace normalization with runtime validation
- HMAC-SHA256 webhook authentication
- Actual before/after subprocess execution with timeouts and bounded logs
- Failure-reproduction gate and four executable regressions
- Local repository graph and impacted-test discovery
- Generated patch and JSON report download endpoints
- Filesystem audit store with atomic writes and run retrieval APIs
- Automatic or manual draft-PR delivery after verification
- Optional after-trace export and Slack notifications
- Secret-safe integration readiness endpoint
- Docker production image, persistent volume, healthcheck, CI, security headers, tests, and responsive UI

## Quick start

```bash
npm install --legacy-peer-deps
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000), inspect the red span, and click **Heal incident**. The server performs the real reproduce/patch/test/commit pipeline and exposes the resulting patch and verification artifacts in the UI.

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Docker

```bash
cp .env.example .env
# Add optional integration secrets.
docker compose up --build
```

Runtime evidence is stored in the `tracehealer-data` volume. See [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Demo proof

The target fixture starts vulnerable:

```bash
cd fixtures/target-agent
node --test # exits non-zero: 3 failures
```

A TraceHealer run uses a copy, never modifies the fixture, and produces:

- before test exit: `1`;
- after test exit: `0`;
- four passing regression checks;
- one real git commit in the isolated workspace;
- `.patch` and verification JSON artifacts;
- before/after profile: 6.842s → 820ms, 4,280 → 612 tokens, $0.0284 → $0.0041.

The profile values come from the scenario replay program; subprocess wall-clock time and TAP logs are preserved separately in the report.

## Architecture

```text
native / neatlogs / OTLP trace
              │
      signature + validation
              │
              ▼
  failure selection and diagnosis
              │
              ▼
 isolated repository workspace ─── context graph
              │
     reproduce original failure
              │
              ▼
       apply minimal repair
              │
              ▼
 exact-input replay + regression tests
              │
       ┌──────┴──────┐
       │             │
    failure        all green
       │             │
 needs-review    local git commit
                     │
             persist artifacts/audit
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
      draft PR   after-trace   Slack
```

Core modules:

- `lib/pipeline.ts` — orchestration and delivery gate
- `lib/sandbox.ts` — workspace, commands, patch, tests, and local commit
- `lib/engine.ts` — failure selection, diagnosis, and patch policy
- `lib/trace-normalizer.ts` — native/wrapped/OTLP intake
- `lib/context.ts` — local repository graph
- `lib/store.ts` — atomic audit persistence
- `lib/github.ts` — draft-only GitHub publication
- `lib/integrations.ts` — after-trace and Slack delivery

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for boundaries and production scaling.

## API

### Run the complete pipeline

```bash
curl -X POST http://localhost:3000/api/heal \
  -H 'Content-Type: application/json' \
  -d '{"mode":"demo"}'
```

A native custom trace can be supplied as `trace`. Unsupported repository/failure strategies return `needs-review` with zero fabricated improvement.

### Receive native or OTLP failure events

```bash
curl -X POST http://localhost:3000/api/webhooks/neatlogs \
  -H 'Content-Type: application/json' \
  -d '{"type":"trace.failed","trace":{...}}'
```

If `NEATLOGS_WEBHOOK_SECRET` is set, include `x-neatlogs-signature: sha256=<hex HMAC>`.

### Audit and artifacts

```bash
curl http://localhost:3000/api/runs
curl http://localhost:3000/api/runs/<run-id>
curl http://localhost:3000/api/artifacts/<run-id>/patch
curl http://localhost:3000/api/artifacts/<run-id>/report
curl -X POST http://localhost:3000/api/runs/<run-id>/publish
```

Additional endpoints: `/api/health`, `/api/incidents`, `/api/integrations`.

## Connected delivery

All variables are optional for the complete local flow.

| Variable | Purpose |
|---|---|
| `TRACEHEALER_DATA_DIR` | Persistent run/workspace/artifact root |
| `NEATLOGS_WEBHOOK_SECRET` | Verify failed-trace intake |
| `NEATLOGS_EXPORT_URL` / `NEATLOGS_API_KEY` | Export verified after-run evidence |
| `GITHUB_TOKEN` | Fine-grained target-repository token |
| `GITHUB_OWNER` / `GITHUB_REPO` | Separate target agent repository |
| `GITHUB_BASE_BRANCH` | Draft PR base, default `main` |
| `AUTO_PUBLISH_DRAFT` | Publish a verified draft during the run |
| `SLACK_WEBHOOK_URL` | Send verified-run notification |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | Reserved optional generic strategy provider |
| `ENTIRE_API_URL` / `ENTIRE_API_KEY` | Reserved optional external graph provider |

The exact neatlogs ingest URL is configurable rather than invented. Point it at the endpoint/schema supplied for your project. GitHub must point at a separate demo target containing `src/order-support.mjs`.

## Safety model

1. Incoming payloads cannot select commands or local filesystem paths.
2. The observed failure must reproduce before any patch is trusted.
3. No green replay means no publication.
4. The default strategy runs a fixed, bounded test command in a copied workspace.
5. GitHub publication creates a draft only; TraceHealer never merges.
6. Unsupported traces remain `needs-review` and receive no fabricated after metrics.
7. Tokens, URLs, raw credentials, and secrets never appear in status responses.

For untrusted arbitrary customer repositories, run each workspace in a disposable container or microVM as described in the operations guide.

## Documentation

- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) — 90-second judging script
- [`docs/HACKATHON_PLAN.md`](docs/HACKATHON_PLAN.md) — execution and judging checklist
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — design and production adapters
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — Docker, persistence, endpoints, and hardening

## License

MIT

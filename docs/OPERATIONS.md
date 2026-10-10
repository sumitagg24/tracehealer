# TraceHealer operations guide

## Runtime modes

### Zero-secret complete local flow

The default mode is not a UI simulation. A healing request:

1. copies `fixtures/target-agent` into a unique workspace;
2. initializes an isolated git repository;
3. runs `node --test` and the production replay to prove the failure;
4. applies the full-file repair;
5. reruns the same input and all regression tests;
6. creates a local git commit only when everything passes;
7. stores the patch and JSON verification report;
8. records the run in the filesystem audit store.

Data defaults to `.tracehealer-data` and is ignored by Git.

### Connected delivery flow

Set server-side environment variables to add delivery after the same verification gate:

- `NEATLOGS_EXPORT_URL` and optional `NEATLOGS_API_KEY`
- `GITHUB_TOKEN`, `GITHUB_OWNER`, `GITHUB_REPO`
- `AUTO_PUBLISH_DRAFT=true` to publish verified drafts during a run
- `SLACK_WEBHOOK_URL`

Delivery failures are recorded but do not erase a valid verification result. They can be retried separately.

## Docker

```bash
cp .env.example .env
# Add only the integrations you need.
docker compose up --build
```

The image includes Node and git, runs as an unprivileged user, exposes port 3000, includes a healthcheck, and stores runtime evidence in the `tracehealer-data` volume.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness and capability report |
| `GET` | `/api/ready` | Readiness: config parses, data root writable |
| `GET` | `/api/metrics` | Service metrics derived from persisted runs |
| `POST` | `/api/heal` | Run the full pipeline synchronously; native trace optional; supports `idempotencyKey` |
| `POST` | `/api/runs` | Create a run asynchronously (202); supports `idempotencyKey` |
| `GET` | `/api/runs` | Persisted healing-run summaries |
| `GET` | `/api/runs/:id` | One complete healing record with audit events |
| `GET` | `/api/runs/:id/progress` | Server-owned state, events, and result for polling |
| `POST` | `/api/runs/:id/cancel` | Cancel an in-flight run |
| `POST` | `/api/runs/:id/publish` | Publish an already-verified draft PR |
| `POST` | `/api/webhooks/neatlogs` | Signed failed-trace intake; accepts native or OTLP JSON |
| `GET` | `/api/incidents` | Current incident list |
| `GET` | `/api/artifacts/:id/patch` | Generated patch artifact |
| `GET` | `/api/artifacts/:id/report` | Machine-readable verification report |
| `GET` | `/api/integrations` | Secret-safe integration readiness |

## Administrator policy

`lib/policy.ts` reads these optional variables (safe defaults in `.env.example`):

- `TRACEHEALER_ALLOWED_REPOSITORIES` / `TRACEHEALER_ALLOWED_PATHS`
- `TRACEHEALER_ALLOWED_BINARIES`
- `TRACEHEALER_PROTECTED_PATHS`
- `TRACEHEALER_ALLOW_TEST_EDITS` / `TRACEHEALER_ALLOW_MODEL_PATCHES`
- `TRACEHEALER_COMMAND_TIMEOUT_MS`, `TRACEHEALER_MAX_OUTPUT_BYTES`,
  `TRACEHEALER_MAX_DIFF_BYTES`, `TRACEHEALER_MAX_REQUEST_BYTES`,
  `TRACEHEALER_RATE_LIMIT`, `TRACEHEALER_RUN_TIMEOUT_MS`,
  `TRACEHEALER_WEBHOOK_TOLERANCE_MS`, `TRACEHEALER_WEBHOOK_REQUIRE_TIMESTAMP`

A malformed numeric value makes `/api/ready` fail safely rather than starting
with a partial configuration.

## Webhook signing

When `NEATLOGS_WEBHOOK_SECRET` is configured, TraceHealer requires:

```text
x-neatlogs-signature: sha256=<hex HMAC-SHA256 of the unmodified body>
x-neatlogs-timestamp: <epoch milliseconds>   # optional unless required
```

Invalid signatures return `401` before parsing. A timestamp outside
`TRACEHEALER_WEBHOOK_TOLERANCE_MS` is rejected, and a repeated signed delivery is
treated as an idempotent duplicate so provider retries are safe.

## Persistence

The included filesystem store uses atomic rename and is appropriate for a single worker/hackathon deployment. Mount `TRACEHEALER_DATA_DIR` on persistent storage. For multiple workers, replace `lib/store.ts` with Postgres and move orchestration to a queue; the API/domain contracts do not need to change.

## Safety controls

- Incoming payloads cannot select arbitrary commands or local paths.
- Demo execution uses a fixed target fixture and fixed `node --test` command.
- Every command has a 20-second timeout and bounded output buffer.
- The before failure must reproduce before source is changed.
- No failed verification can publish.
- GitHub publication creates draft PRs only.
- Tokens and URLs never leave server-side environment variables.
- Runtime artifact paths are validated before download.

## Production checklist

- [ ] Put the service behind authenticated ingress.
- [ ] Configure a random webhook secret.
- [ ] Use a GitHub App installation token rather than a PAT.
- [ ] Point GitHub at a separate target repository.
- [ ] Use one isolated container/microVM per untrusted repository run.
- [ ] Replace filesystem persistence for horizontal scaling.
- [ ] Redact PII/secrets from trace payloads before model-provider use.
- [ ] Keep branch protection and required human review enabled.
- [ ] Back up verification reports and audit records.

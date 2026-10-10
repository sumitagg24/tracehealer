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
| `POST` | `/api/heal` | Run the full pipeline; native trace optional |
| `POST` | `/api/webhooks/neatlogs` | Signed failed-trace intake; accepts native or OTLP JSON |
| `GET` | `/api/incidents` | Current incident list |
| `GET` | `/api/runs` | Persisted healing-run audit log |
| `GET` | `/api/runs/:id` | One complete healing record |
| `POST` | `/api/runs/:id/publish` | Publish an already-verified draft PR |
| `GET` | `/api/artifacts/:id/patch` | Generated patch artifact |
| `GET` | `/api/artifacts/:id/report` | Machine-readable verification report |
| `GET` | `/api/integrations` | Secret-safe integration readiness |

## Webhook signing

When `NEATLOGS_WEBHOOK_SECRET` is configured, TraceHealer requires:

```text
x-neatlogs-signature: sha256=<hex HMAC-SHA256 of the unmodified body>
```

Invalid signatures return `401` before parsing.

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

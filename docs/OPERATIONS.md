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

## Running a production build

The build uses `output: "standalone"`. Next.js warns that `next start` is not the
supported runner for standalone output; start the emitted server directly:

```bash
npm run build
node .next/standalone/server.js   # honors HOSTNAME and PORT
```

The Docker image already does this (`CMD ["node", "server.js"]`). `npm run dev`
remains the way to develop, and `npm start` still serves locally but prints that
standalone warning.

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
| `GET` | `/api/ready` | Canonical readiness: config parses, data root writable |
| `GET` | `/api/readiness` | Compatibility alias; identical status/payload/headers to `/api/ready` |
| `GET` | `/api/metrics` | Service metrics derived from persisted runs |
| `POST` | `/api/heal` | Run the full pipeline synchronously; requires explicit `mode`; supports `idempotencyKey` |
| `POST` | `/api/runs` | Create a run asynchronously (202); requires explicit `mode`; supports `idempotencyKey` |
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

## Authentication and tenancy

| Variable | Purpose |
|---|---|
| `TRACEHEALER_AUTH_MODE` | `local` (default, development only) or `session` (production) |
| `TRACEHEALER_SESSION_SECRET` | HMAC key for session cookies; required by `session` mode |
| `TRACEHEALER_LOCAL_AUTH_ACK` | Must be `true` for `local` mode to serve under `NODE_ENV=production` |
| `TRACEHEALER_TENANT_ID`, `TRACEHEALER_WORKSPACE_ID` | Tenant/workspace assigned to local-mode requests |

`local` mode is development-only. It serves a synthetic `admin` principal so the
zero-secret demo works, and it fails closed with `503 unconfigured` when
`NODE_ENV=production` unless `TRACEHEALER_LOCAL_AUTH_ACK=true`. Never enable that
acknowledgement for a deployment that is reachable by untrusted users.

`session` mode fails closed with `503 unconfigured` when
`TRACEHEALER_SESSION_SECRET` is missing, and returns `401 unauthorized` for a
missing, tampered, or expired `tracehealer_session` cookie. The cookie is
HTTP-only, `SameSite=Lax`, and `Secure` in production.

Roles are least-privilege: `viewer` can read runs and artifacts; `operator` can
also create, cancel, retry, and publish; only `admin` can change administrator
policy or integration configuration. Every resource read is scoped to the
caller's tenant, and a cross-tenant identifier returns `404`, not `403`, so IDs
cannot be enumerated.

Cookie-authenticated mutations are origin-checked before any side effect, so a
foreign `Origin` receives `403 invalid-origin`. Provider webhooks use their own
HMAC signature and never accept the browser session cookie.

Sessions are minted by the deployment's identity layer with
`issueSessionToken(session, secret)` from `lib/auth.ts` and set on the
`tracehealer_session` cookie. There is no built-in password login and no
server-side revocation list yet, so a leaked token remains valid until its
`expiresAt`; keep the TTL short and rotate `TRACEHEALER_SESSION_SECRET` to
invalidate every outstanding session.

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

- [ ] Set `TRACEHEALER_AUTH_MODE=session` and a 32-byte `TRACEHEALER_SESSION_SECRET`.
- [ ] Leave `TRACEHEALER_LOCAL_AUTH_ACK=false` so local mode cannot serve production traffic.
- [ ] Put the service behind authenticated ingress.
- [ ] Configure a random webhook secret.
- [ ] Use a GitHub App installation token rather than a PAT.
- [ ] Point GitHub at a separate target repository.
- [ ] Use one isolated container/microVM per untrusted repository run.
- [ ] Replace filesystem persistence for horizontal scaling.
- [ ] Redact PII/secrets from trace payloads before model-provider use.
- [ ] Keep branch protection and required human review enabled.
- [ ] Back up verification reports and audit records.

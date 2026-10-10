# TraceHealer architecture

## Product boundary

TraceHealer begins where observability ends. A trace provider records what an agent did; TraceHealer turns a failed run into reproducible evidence, a minimal source change, and a verification-gated review artifact.

It deliberately does **not** merge code. Autonomous diagnosis, reproduction, patching, and verification are inside the boundary. Production approval remains human-owned.

## Implemented lifecycle

1. **Intake** — `POST /api/heal` accepts the native contract. `POST /api/webhooks/neatlogs` accepts native, wrapped event, or OTLP JSON.
2. **Authentication** — when configured, webhook HMAC is checked against the unmodified body with a timing-safe comparison.
3. **Normalization and validation** — provider formats normalize to `AgentTrace`; Zod enforces the runtime contract.
4. **Failure selection** — the engine prefers a specific failed application span with a stack frame over noisy root/retry errors.
5. **Classification** — schema drift, invalid JSON, timeout, rate limit, or unknown.
6. **Localization and context** — stack frames provide file/line/symbol; the local graph discovers related source, symbols, and tests.
7. **Workspace** — the target fixture is copied to a unique data directory and initialized as a real git repository.
8. **Reproduction** — original tests and the failed production input run before any change. A non-reproduced failure stops the pipeline.
9. **Patch** — the trusted strategy updates the isolated source and captures an actual git diff.
10. **Verification** — `node --test` and the production replay run after patching with timeout and output limits.
11. **Commit and evidence** — a green repair receives a local git commit, `.patch`, JSON report, TAP logs, before/after profile, and context metadata.
12. **Persistence** — atomic JSON writes create the audit record.
13. **Delivery** — optional independent adapters publish a draft PR, export after-run evidence, and notify Slack.

External delivery failure is retryable and does not rewrite a valid verification result.

## Runtime structure

```text
app/api/*
  │
  ├─ trace-normalizer.ts ── schema.ts
  │
  └─ pipeline.ts
       ├─ engine.ts          diagnosis and policy
       ├─ context.ts         repository graph
       ├─ sandbox.ts         workspace, commands, git, artifacts
       ├─ store.ts           atomic run persistence
       ├─ github.ts          draft-only publication
       └─ integrations.ts    after-trace and Slack delivery
```

## Core model

```text
AgentTrace
  └─ TraceSpan[]
       ├─ input/output and provider attributes
       ├─ status/error/stack
       └─ token, cost, and duration data

HealResult
  ├─ Diagnosis
  ├─ CodePatch
  ├─ VerificationResult
  │    ├─ executable checks
  │    ├─ before/after metrics
  │    └─ calculated improvements
  ├─ RepositoryContext
  ├─ Artifact metadata and bounded logs
  ├─ Draft proposal metadata
  ├─ Integration delivery state
  └─ ordered audit steps
```

`lib/types.ts` contains the domain types. `lib/schema.ts` contains external validation. Unsupported strategies return `needs-review` with unchanged after metrics.

## Deterministic strategy

The included strategy is designed to be reliable under hackathon conditions without pretending to solve arbitrary codebases:

- The source fixture is vulnerable and its tests genuinely fail.
- The exact tool response from the trace is executed before and after.
- The original fixture remains immutable; only the workspace changes.
- Four regressions test the observed payload, legacy compatibility, v3 compatibility, and invalid-contract behavior.
- A commit is created only after all tests pass.
- The UI receives the server result and does not manufacture success.

This is a complete vertical slice and the reference implementation for additional `PatchStrategy` and `SandboxProvider` implementations.

## Persistence and concurrency

The included store writes one JSON document per run via temporary-file + atomic rename. Workspaces and artifacts are namespaced by random run IDs. This supports one Node instance and persistent Docker volume.

For horizontal production operation:

- put run state/audit events in Postgres;
- put artifacts in S3-compatible storage;
- enqueue jobs through SQS/BullMQ;
- enforce one idempotency key per source trace/fingerprint;
- execute each untrusted checkout in a disposable container or microVM;
- let the web service poll or stream worker state.

The domain response does not need to change.

## Provider boundaries

### Trace provider / neatlogs

The webhook currently accepts native and OTLP JSON and supports HMAC. `NEATLOGS_EXPORT_URL` is configurable because the exact ingest route and schema are project-specific; the adapter sends trace ID, run ID, before/after metrics, checks, and patch summary.

### Repository context / Entire

The working local graph provider returns inspected files, tests, and symbols. An Entire adapter can implement the same output and add `checkpointId`; credentials are detected but no undocumented external API is invented.

### Patch strategy / model provider

The current trusted strategy is deterministic. A general model strategy should receive only redacted failure evidence, allowlisted source context, and impacted tests; require structured full-file output; reject undeclared paths; and always pass through the same reproduction/verification gate. Model credentials are detected but are never required for the reliable path.

### Sandbox

The local process provider is suitable for the fixed trusted fixture. Arbitrary third-party code must run outside the web process with CPU, memory, PID, filesystem, network, and wall-clock limits. The Docker image packages the service itself; it is not a per-customer-code security boundary.

### GitHub

`lib/github.ts` creates a branch from the configured base, writes the verified full file, and creates a draft PR. Automatic delivery is opt-in. Manual delivery is available at `POST /api/runs/:id/publish`. Both paths reject unverified runs. A production installation should use a GitHub App token.

## Security properties

- Raw-body timing-safe HMAC verification
- Runtime payload validation
- Fixed command/path strategy for the built-in flow
- 20-second command timeout and 1 MiB output limit
- Failure must reproduce before mutation
- Complete regression pass required before commit/publication
- Artifact path reconstruction and run-ID validation
- Secret-safe integration status
- Draft-only publication; no merge endpoint
- Security response headers and unprivileged Docker runtime

Production still needs authenticated ingress, trace PII redaction, a hardened untrusted-code runner, rate limits, and tenant isolation.

## Deployment

`Dockerfile` builds the Next.js standalone server, installs git, runs as an unprivileged user, persists `/data`, and includes a healthcheck. `compose.yaml` wires the volume and optional integrations.

Recommended production shape:

- Web/API: ECS, App Runner, Kubernetes, or another Node 20+ container host
- State: Postgres
- Queue: SQS/BullMQ
- Artifacts: S3
- Execution: ECS task, CodeBuild, Firecracker, or hardened Kubernetes Job
- Secrets: AWS Secrets Manager or equivalent
- Agent observability: neatlogs

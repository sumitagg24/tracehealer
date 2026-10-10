# TraceHealer architecture

## Product boundary

TraceHealer is not another observability dashboard. neatlogs remains the system that records and visualizes agent behavior. TraceHealer starts where a failed trace ends: it turns production evidence into a reviewable software change.

## Request lifecycle

1. **Intake** — `POST /api/heal` or `POST /api/webhooks/neatlogs` receives a typed `AgentTrace`.
2. **Validation** — Zod rejects incomplete or malformed payloads before orchestration.
3. **Failure selection** — the engine prefers the deepest error span with an application stack frame over noisy parent/retry failures.
4. **Classification** — the current deterministic policy recognizes schema drift, invalid JSON, timeout, and rate-limit fingerprints.
5. **Localization** — stack frames yield file, line, and symbol; related successful tool spans become supporting evidence.
6. **Patch strategy** — a focused strategy emits a unified diff and rationale.
7. **Replay** — the exact tool output from the failed trace is run against vulnerable and healed implementations, followed by contract regression cases.
8. **Gate** — only a fully green suite produces `healed`; all other runs return `needs-review`.
9. **Publish** — after human approval, `publishDraftPullRequest` can create a branch, commit full-file content, and open a draft GitHub PR.

## Core model

```text
AgentTrace
  └─ TraceSpan[]
       ├─ input / output
       ├─ status / error / stack
       ├─ token and cost data
       └─ arbitrary provider attributes

HealResult
  ├─ Diagnosis
  ├─ CodePatch
  ├─ VerificationResult
  │    ├─ checks[]
  │    ├─ before / after metrics
  │    └─ calculated improvements
  ├─ timeline steps
  └─ proposal metadata
```

See `lib/types.ts` for exact interfaces and `lib/schema.ts` for the external payload contract.

## Why deterministic demo mode

Hackathon demos often fail because a model provider, sandbox, or third-party API becomes unavailable. The included scenario is deterministic but not merely animated:

- It reads the exact `lookup_order` output in the failed trace.
- It reproduces the old implementation's `TypeError`.
- It executes the healed implementation against the same response.
- It runs legacy v2, current v3, and invalid-contract regressions.
- The API result is generated on the server; the client only visualizes it.

This gives judges a reliable proof loop while preserving clean seams for production adapters.

## Production adapter plan

### neatlogs

Normalize a neatlogs failed-run export/webhook into `AgentTrace`. Keep raw trace deep links in `metadata`. The webhook already supports optional HMAC-SHA256 verification.

### Repository context / Entire

Implement a `RepositoryContextProvider`:

```ts
interface RepositoryContextProvider {
  locate(frame: { file: string; line: number; symbol: string }): Promise<{
    source: string;
    dependencies: string[];
    tests: string[];
  }>;
}
```

An Entire-backed provider can return graph-neighbor files and checkpoint identifiers without changing the healing engine contract.

### Model patcher

Implement a `PatchStrategy` that receives only the failed span, evidence chain, focused source context, and relevant tests. Require structured output and validate that changed files remain within an allowlist.

### Sandbox verifier

Use an isolated ephemeral runner (AWS CodeBuild/ECS/Fargate, Firecracker, or a hardened job worker). The runner should:

- check out the exact traced commit;
- apply the patch;
- run the generated repro first;
- run impacted tests and static checks;
- enforce CPU, memory, time, network, and filesystem limits;
- emit the after trace back to neatlogs.

### GitHub

`lib/github.ts` already handles the draft-PR publication path. Production hardening should use a GitHub App installation token rather than a long-lived personal token, protect against branch collisions, and attach check-run annotations.

## Security / safety

- The webhook can require a raw-body HMAC signature.
- Payloads are runtime validated.
- No repository write happens during webhook or diagnosis routes.
- PR creation is split into an explicit publishing operation.
- The token should be fine-grained and repository-scoped.
- Production code execution must happen outside the web process in a disposable sandbox.
- Trace secrets/PII should be redacted before model context assembly.
- Automatic merge is intentionally out of scope.

## Deployment

The app is a standard Next.js Node deployment. Demo mode needs no persistent store. For production:

- Web: Vercel, ECS, App Runner, or any Node 20+ host
- Queue: SQS / BullMQ for long-running healing jobs
- Store: Postgres for incidents, run state, audit events, and tenant configuration
- Sandbox: CodeBuild/ECS isolated workers
- Secrets: AWS Secrets Manager or platform-equivalent
- Observability: neatlogs for agent traces plus conventional app metrics

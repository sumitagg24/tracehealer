# TraceHealer

> **Failure trace → root cause → minimal patch → deterministic replay → review-ready PR**

TraceHealer is an autonomous incident-response agent for production AI agents. It consumes a failed trace, identifies the first actionable application failure, maps it to source code, proposes the smallest safe patch, and replays the exact failed input before a human reviews the change.

Built for **neatHack** around one sharp demo: an Order API schema change crashes a support agent, causes a three-attempt retry loop, and wastes 4,280 tokens. TraceHealer contains it in seconds and proves the improvement.

## What is working

- Polished incident workbench with span waterfall, inspector, diagnosis, patch diff, and verification report
- Typed `POST /api/heal` API and neatlogs-compatible failure webhook
- Deterministic root-cause engine for schema drift, malformed JSON, timeouts, and rate limits
- **Real executable replay** of the failed Order API payload plus legacy, v3, and missing-field regression cases
- Before/after evidence: 6.84s → 820ms, 4,280 → 612 tokens, $0.0284 → $0.0041
- HMAC webhook verification when `NEATLOGS_WEBHOOK_SECRET` is configured
- Isolated GitHub draft-PR publisher that can only be called after explicit approval
- Responsive interface, health endpoint, strict TypeScript, linting, unit tests, and production build
- Zero-secret demo mode for a reliable hackathon presentation

## Quick start

```bash
npm install --legacy-peer-deps
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and click **Heal incident**. No external API key is needed for the full demo path.

Quality checks:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

## Demo flow

1. The incident opens on the failed `order.normalize` span.
2. The trace shows `tool.lookup_order` succeeded with API v3, then `customer.email` threw.
3. Click **Heal incident** (or press `⌘/Ctrl + Enter`).
4. TraceHealer isolates `src/agents/order-support.ts:47`, proposes a compatibility guard, and runs four deterministic checks.
5. The verification report shows the before/after latency, token, cost, and error deltas.
6. Click **Review proposed patch** to inspect the exact one-file diff.

See [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) for a 90-second submission script.

## Architecture

```text
neatlogs failed trace / webhook
             │
             ▼
     trace validation (Zod)
             │
             ▼
  failure selection + classification
             │
             ▼
 source location + evidence chain
             │
             ▼
      minimal patch proposal
             │
             ▼
 exact-input replay + regression suite
             │
       ┌─────┴─────┐
       │           │
    failed       passed
       │           │
  needs review   draft PR proposal
                   │
                   ▼
              human approval
```

The deterministic demo engine lives in `lib/engine.ts`; the executable target and replay harness live in `fixtures/demo-agent` and `lib/replay.ts`. Diagnosis and mutation are deliberately separated: `lib/github.ts` cannot run as a side effect of trace ingestion.

A production version can swap the deterministic patch strategy for an LLM/repository-graph adapter while preserving the same typed engine contract and verification gate. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## API

### Start a healing run

```bash
curl -X POST http://localhost:3000/api/heal \
  -H 'Content-Type: application/json' \
  -d '{"mode":"demo"}'
```

Pass `{ "trace": <AgentTrace>, "mode": "connected" }` to analyze a custom trace. An unsupported trace is diagnosed but remains `needs-review` until a deterministic replay fixture exists.

### Receive a failed trace

```bash
curl -X POST http://localhost:3000/api/webhooks/neatlogs \
  -H 'Content-Type: application/json' \
  -d '{"type":"trace.failed","trace":{...}}'
```

When `NEATLOGS_WEBHOOK_SECRET` is set, include:

```text
x-neatlogs-signature: sha256=<HMAC-SHA256 of raw request body>
```

### Health

```bash
curl http://localhost:3000/api/health
```

## Environment

All variables are optional for demo mode. Copy `.env.example` for the complete list.

| Variable | Purpose |
|---|---|
| `NEATLOGS_WEBHOOK_SECRET` | Verify incoming trace webhooks |
| `NEXT_PUBLIC_NEATLOGS_DASHBOARD_URL` | Base URL for future deep links |
| `GITHUB_TOKEN` | Fine-grained token for the target demo repository |
| `GITHUB_OWNER` / `GITHUB_REPO` | Target repository for draft PRs |
| `GITHUB_BASE_BRANCH` | PR base; defaults to `main` |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | Reserved model-provider adapter configuration |

Use a GitHub token scoped only to the target demo repository. TraceHealer never merges automatically.

## Repository map

```text
app/                         Next.js UI and API routes
components/                  Incident workbench and brand UI
fixtures/demo-agent/         Executable vulnerable/healed target logic
lib/engine.ts                Diagnosis, patch and verification orchestration
lib/replay.ts                Exact-input deterministic replay suite
lib/github.ts                Approval-gated draft PR publisher
lib/schema.ts                Runtime request and trace validation
lib/*.test.ts                Engine tests
docs/                        Plan, architecture and demo script
```

## Safety principles

1. **Read first, write later.** Trace intake never mutates a repository.
2. **No green replay, no PR.** Unsupported traces stay `needs-review`.
3. **Small patches.** One failure fingerprint, one focused proposal.
4. **Human merge gate.** Publishing creates drafts; merging is never automated.
5. **Evidence attached.** Every proposal carries trace, diagnosis, tests, and before/after metrics.

## Hackathon plan

The execution plan, sponsor integration boundaries, judging evidence, and post-hackathon roadmap are in [`docs/HACKATHON_PLAN.md`](docs/HACKATHON_PLAN.md).

## License

MIT

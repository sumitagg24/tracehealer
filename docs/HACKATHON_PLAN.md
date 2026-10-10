# TraceHealer hackathon plan

## Winning thesis

**neatlogs tells you exactly how an agent failed. TraceHealer turns that evidence into a verified fix.**

The demo is designed around a visually obvious before/after loop, not a feature checklist:

- Before: red trace, stale response contract, 3 retries, 6.84s, 4,280 tokens, $0.0284.
- Action: isolate one source frame, generate a one-file compatibility patch, replay exact input.
- After: green checks, 820ms, 612 tokens, $0.0041, zero errors.
- Safety: draft/review only; never auto-merge.

## Current milestone — complete

- [x] Product concept and demo incident
- [x] Responsive production-style incident workbench
- [x] Trace span waterfall and error inspector
- [x] Root-cause evidence view
- [x] Patch diff review
- [x] Executable exact-input replay and contract regression suite
- [x] Before/after verification report
- [x] Typed heal API and signed webhook endpoint
- [x] Actual isolated workspace with before-failure reproduction
- [x] Real git diff, after-tests, local commit, and downloadable artifacts
- [x] Native/wrapped/OTLP trace normalization
- [x] Repository context graph and impacted-test discovery
- [x] Atomic audit persistence and run APIs
- [x] Approval-gated automatic/manual GitHub draft PR delivery
- [x] Optional after-trace export and Slack delivery
- [x] Complete control-center navigation and integration readiness UI
- [x] Docker image, persistent volume, healthcheck, and operations guide
- [x] Tests, lint, strict typecheck, production build
- [x] Demo script and architecture docs

## 48-hour execution plan

### Block 1 — product proof (hours 0–8)

1. Freeze the single schema-drift story.
2. Record a real failed target-agent run in neatlogs.
3. Export the trace into the `AgentTrace` contract.
4. Confirm old code fails and patched code passes locally.
5. Save trace IDs and screenshots immediately.

**Exit evidence:** one red neatlogs trace and one executable local repro.

### Block 2 — connected loop (hours 8–20)

1. Map the neatlogs export/webhook payload into the normalizer.
2. Point the GitHub adapter at a separate demo target repository.
3. Add the full-file output corresponding to the generated diff.
4. Create a real draft PR only after verification passes.
5. Put trace link, root cause, replay checks, and metrics in the PR body.

**Exit evidence:** clicking heal produces a draft PR in the demo repository.

### Block 3 — sponsor depth (hours 20–30)

1. Use Entire/repository graph context to locate callers and impacted tests.
2. Store Entire checkpoint/graph references in the healing result.
3. Run replay in an isolated AWS worker.
4. Emit the healed run as a second neatlogs trace.
5. Keep Dodo/CFO integrations out of the core path unless the required flow is already stable.

**Exit evidence:** before and after traces plus repository-context proof.

### Block 4 — submission polish (hours 30–42)

1. Replace seeded after metrics with the actual healed neatlogs run.
2. Rehearse the 90-second demo until it is under time.
3. Capture a clean 1080p recording; zoom browser to make metrics readable.
4. Prepare one architecture graphic and one before/after image.
5. Test from a fresh browser and a fresh clone.

### Block 5 — ship (hours 42–48)

1. Deploy the web app.
2. Run `typecheck`, `lint`, `test`, and `build` from the final commit.
3. Confirm webhook and health endpoints on production.
4. Submit early; pin the demo post and repository.
5. Keep a local recording and demo-mode fallback ready.

## Scope discipline

### Must have

- Real neatlogs before trace
- Exact-input replay
- Minimal code diff
- Green after trace or reproducible test output
- Human review gate
- 90-second story

### Nice to have

- Entire context graph
- Real GitHub draft PR
- AWS isolated replay worker
- Slack notification
- Unit-economics card

### Do not build during the hackathon

- Multi-tenant auth and billing
- Autonomous merge/deploy
- Generic support for every language/framework
- A complex incident list/analytics suite
- More demo scenarios before the first one is perfect

## Sponsor integration policy

Use integrations only when they are real and visible in the proof loop:

- **neatlogs:** source of failed and healed traces; primary evidence.
- **Entire:** repository-context provider and checkpoint metadata.
- **AWS:** isolated execution worker if time allows.
- **GitHub:** draft change review and CI.
- **Dodo/CFO:** optional business layer, never fake a checkout or financial result.

No sponsor requirement should be invented. Match the published hackathon rules and APIs before describing an integration as complete.

## Judging proof checklist

- [ ] Show the exact failed span and tool output.
- [ ] Explain the root cause in one sentence.
- [ ] Show the patch is one file and narrowly scoped.
- [ ] Show exact-input replay and four checks.
- [ ] Show before/after trace links, not only UI numbers.
- [ ] Show no auto-merge and explain the safety boundary.
- [ ] End on quantified impact and a memorable one-liner.

## Business framing

Initial customer: teams with 5–50 production AI workflows and an engineer on-call for agent failures.

Pricing hypothesis: platform fee plus a verified-resolution tier. The core ROI calculation should be based on observed incident handling time, model cost avoided, and the percentage of proposals engineers accept—not made-up market-size claims.

North-star metric: **verified fixes accepted by a human / actionable failed traces**.

Supporting metrics:

- median time from failed trace to verified proposal;
- replay pass rate;
- PR acceptance and edit rate;
- incidents prevented from recurring;
- tokens/cost avoided after accepted fixes.

## Post-hackathon roadmap

1. Add trace adapters and repository context interfaces.
2. Move runs to a queue and isolated sandbox.
3. Add GitHub App installation auth and check runs.
4. Persist incidents, runs, audit events, and tenant policy.
5. Add policy controls: allowed repositories, paths, test commands, cost caps.
6. Learn from accepted/rejected patches to improve strategy selection.

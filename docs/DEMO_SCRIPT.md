# 90-second TraceHealer demo script

## Setup

- Open the incident page at desktop width.
- Keep the failed `order.normalize` span selected.
- Use demo mode unless the live neatlogs/GitHub path has been rehearsed twice.
- Record at 1080p or higher; hide bookmarks and notifications.

## Script

### 0:00–0:10 — hook

> “AI agents fail in production, but the engineer usually starts with a trace and still has to do the entire fix. TraceHealer turns that trace into a verified patch.”

Show the critical incident title and affected-run count.

### 0:10–0:25 — failure

> “Our support agent can no longer email receipts. neatlogs shows that order lookup succeeded, but Order API v3 moved the email field. The agent crashes and burns another 3,358 tokens retrying the same bad code.”

Click the successful `tool.lookup_order` span, then the red `order.normalize` span. Keep the stack frame visible.

### 0:25–0:48 — healer

Click **Heal incident**.

> “TraceHealer imports the spans, picks the first actionable application frame—not the noisy parent error—maps it to line 47, generates the smallest compatibility patch, and replays the exact failed payload.”

Let the five healing steps complete.

### 0:48–1:07 — proof

Scroll to the verification report.

> “The exact failure now passes, the legacy contract still works, the v3 contract works, and missing data produces a typed error instead of a retry loop. Latency drops 88%, tokens 86%, and cost 86%, with zero errors.”

Pause briefly so the four numbers can be read.

### 1:07–1:20 — patch and safety

Click **Review proposed patch**.

> “The proposal changes one file and ten lines. It is review-only: TraceHealer will prepare a draft PR, but it never merges automatically.”

Show the green/red diff.

### 1:20–1:30 — close

> “neatlogs gives agents the context to fix failures. TraceHealer closes the loop: failure trace, root cause, verified patch—in seconds.”

End on the diff or before/after report, whichever reads best in the final recording.

## Backup lines

If a live integration is slow:

> “I’m switching to deterministic replay mode. It executes the same exported trace payload and the same regression gate without depending on an external model.”

If asked whether the metrics are live:

> “The included demo values correspond to the exported scenario. For judging, we attach the real neatlogs before/after trace links; unsupported custom traces stay needs-review rather than receiving fabricated green metrics.”

## Likely judge questions

**Why is this different from a coding agent?**  
A coding agent starts from a task description. TraceHealer starts from structured production evidence, builds a deterministic repro, and gates the proposal on exact-input replay.

**Why not auto-merge?**  
Production traces may contain incomplete context and generated patches can be wrong. The valuable autonomous boundary is diagnosis plus verified proposal; policy-controlled merging can come later.

**Is the demo just an animation?**  
No. The UI calls the server healing API. The replay harness reproduces the old failure using the trace's actual tool output and executes four checks against the healed implementation.

**What happens for an unsupported failure?**  
It is classified and localized, but returns `needs-review` because no deterministic replay fixture exists. No green status and no publish action.

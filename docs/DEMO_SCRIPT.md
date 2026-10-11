# TraceHealer demo scripts

## Setup

- Open the incident page at desktop width.
- Keep the failed `order.normalize` span selected.
- Use demo mode unless the live neatlogs/GitHub path has been rehearsed twice.
- Record at 1080p or higher; hide bookmarks and notifications.
- Run the server yourself on loopback (see the repository README) before recording.

The pre-recorded demo video is a **36-second** screen capture. This document supplies a narration that matches it frame for frame, plus a **90-second** live flow for judges who want to drive it themselves.

---

## 36-second narration

For the recorded video, or as captions if recording narration is inconvenient:

> AI agents can fail silently when production schemas drift. TraceHealer ingests that failed trace, reproduces the exact error, finds the relevant repository context, creates a constrained repair, and reruns the regression suite. Here the original test exits with code one. After healing, it exits zero with all four checks passing. Every state transition and artifact is audited, and unverified repairs are never published. TraceHealer also provides a cross-platform desktop control center, with unsigned preview downloads for Windows, macOS, and Linux.

Approximate timing over the 36-second capture:

| Time | On screen |
|---|---|
| 0–5 s | The failing trace: `agent.run` errored, red `order.normalize` span, real stack |
| 5–14 s | **Heal this incident** pressed; server-driven progress through the healing states |
| 14–21 s | Result: all four checks pass, `before exit 1 → after exit 0` |
| 21–28 s | Run detail: timeline, checks, artifacts, diff |
| 28–36 s | Notifications, then the unsigned preview download page |

Note: "live" throughout means live **run and trace progress** driven by the server. There is no audio or microphone transcription in this product, and none is claimed.

---

## 90-second live demo

### 0:00–0:08 — hook

> "AI agents fail in production, but the engineer usually starts with a trace and still has to do the entire fix. TraceHealer turns that trace into a verified patch."

Show the incident view: the failing trace, the affected run count, and the red span.

### 0:08–0:20 — the failed trace

Click the successful `tool.lookup_order` span, then the red `order.normalize` span. Keep the stack frame visible.

> "The order lookup succeeded, but the API moved the email field. The agent crashes on `Cannot read properties of undefined (reading 'email')`, and every retry hits the same bad code."

### 0:20–0:32 — start the heal

Click **Heal this incident**.

> "TraceHealer imports the spans, picks the first actionable application frame — not the noisy parent error — maps it to the exact source line, and reproduces the failure in a copied workspace."

### 0:32–0:45 — live progress

Let the healing states advance. The card is driven by real server state, not a client-side timer.

> "These are persisted lifecycle states from the server: reproducing, diagnosing, patching, verifying, committing."

### 0:45–0:58 — the proof

Scroll to the verification report.

> "The original test exited with code one. After the repair, the same input exits zero, and all four checks pass: the exact failing payload, the legacy contract, the current contract, and the typed-error behaviour."

Pause so the exit-code transition and `4/4` can be read.

### 0:58–1:08 — patch and artifacts

Click **Review proposed patch**.

> "One file, a minimal diff. The run also produces a patch file, a machine-readable verification report, and a full audit timeline."

### 1:08–1:20 — safety boundary

> "TraceHealer will prepare a draft pull request, but it never merges automatically. And if it cannot honestly fix something, the run settles as `needs-review` — no fabricated green result."

Optionally press **Publish** with no GitHub token configured, to show it failing honestly: "GitHub publishing is not configured."

### 1:20–1:30 — close

> "Here is the desktop control center, connected to the same service, and unsigned preview downloads for Windows, macOS, and Linux. Failure trace, root cause, verified patch — in seconds."

Show the desktop runtime proof, then the release page, then the limitations slide.

---

## Honest limitations slide

Keep this on screen at the end:

- Installers are **unsigned**; macOS builds are **not notarized**.
- External providers (OIDC, GitHub delivery, neatlogs, Slack, model providers, Entire, AWS) are **unconfigured** and were not exercised against live infrastructure.
- The tag-triggered release path is implemented but has not run for a tag.
- Audio / microphone transcription is not implemented.
- The desktop client is a control center for a service you run — **not** a standalone offline repair engine.
- In the packaged Windows app, tray actions, native notification delivery/click, deep links, sign-out/vault cleanup, the server-unavailable state, and interactive SmartScreen behaviour remain unverified.

---

## Backup lines

If a live integration is slow:

> "I'm switching to deterministic replay mode. It executes the same exported trace payload and the same regression gate without depending on any external service."

If asked whether the metrics are live:

> "The values in this demo correspond to the included exported scenario, not a production workload. The claim we stand behind is the deterministic one: exit code one becomes zero, and four of four checks pass. Unsupported custom traces stay `needs-review` rather than receiving fabricated green metrics."

## Likely judge questions

**Why is this different from a coding agent?**
A coding agent starts from a task description. TraceHealer starts from structured production evidence, builds a deterministic repro, and gates the proposal on exact-input replay.

**Why not auto-merge?**
Production traces may contain incomplete context and generated patches can be wrong. The valuable autonomous boundary is diagnosis plus verified proposal; policy-controlled merging can come later.

**Is the demo just an animation?**
No. The UI calls the server healing API. The replay harness reproduces the old failure using the trace's actual tool output and executes four checks against the healed implementation.

**What happens for an unsupported failure?**
It is classified and localized, but returns `needs-review` because no deterministic replay fixture exists. No green status and no publish action.

**Can it run with no internet and no API key?**
Yes. The demo flow needs no secret of any kind. The default repair strategy is deterministic and local.

import { listRunSummaries, readRunEvents } from "@/lib/store";
import { isTerminal } from "@/lib/run-state";
import type { RunSummary } from "@/lib/types";

export interface ServiceMetrics {
  runCount: number;
  activeRuns: number;
  byState: Record<string, number>;
  healed: number;
  needsReview: number;
  successRatePercent: number;
  deliveryFailureRuns: number;
  deliveryFailureEvents: number;
  timeoutCount: number;
  cancelledCount: number;
  averageDurationMs: number | null;
}

/**
 * Metrics are derived only from persisted run records and the append-only audit
 * trail. Nothing here is synthesized: an empty store reports zeros.
 */
export async function computeMetrics(limit = 100): Promise<ServiceMetrics> {
  const summaries: RunSummary[] = await listRunSummaries(limit);
  const byState: Record<string, number> = {};
  let healed = 0;
  let needsReview = 0;
  let deliveryFailureRuns = 0;
  let deliveryFailureEvents = 0;
  let timeoutCount = 0;
  let cancelledCount = 0;
  let activeRuns = 0;
  const durations: number[] = [];

  for (const summary of summaries) {
    byState[summary.state] = (byState[summary.state] ?? 0) + 1;
    if (!isTerminal(summary.state) && summary.state !== "delivery-failed") activeRuns += 1;
    if (summary.state === "healed") healed += 1;
    if (summary.state === "needs-review") needsReview += 1;
    if (summary.state === "delivery-failed") deliveryFailureRuns += 1;
    if (summary.state === "timed-out") timeoutCount += 1;
    if (summary.state === "cancelled") cancelledCount += 1;
    if (summary.completedAt) {
      durations.push(Date.parse(summary.completedAt) - Date.parse(summary.startedAt));
    }
  }

  for (const summary of summaries.slice(0, 50)) {
    const events = await readRunEvents(summary.id);
    for (const event of events) {
      if (event.state === "delivery-failed") deliveryFailureEvents += 1;
    }
  }

  const settled = healed + needsReview;
  return {
    runCount: summaries.length,
    activeRuns,
    byState,
    healed,
    needsReview,
    successRatePercent: settled === 0 ? 0 : Math.round((healed / settled) * 100),
    deliveryFailureRuns,
    deliveryFailureEvents,
    timeoutCount,
    cancelledCount,
    averageDurationMs: durations.length
      ? Math.round(durations.reduce((total, value) => total + value, 0) / durations.length)
      : null,
  };
}

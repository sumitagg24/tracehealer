import { NextResponse } from "next/server";
import { jsonError, noStore } from "@/lib/http";
import { authorize } from "@/lib/auth";
import { computeMetrics } from "@/lib/metrics";
import { readRunSummaries, readRun } from "@/lib/run-read";
import { buildReportingSummary, parseReportingAssumptions } from "@/lib/reporting";
import { configuredSponsorLinks, notificationEntryFromRun } from "@/lib/notifications";
import type { NotificationEntry } from "@/lib/notifications";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const session = authorize(request, "run:read");
    const metrics = await computeMetrics(session.tenantId);
    // Bounded: only the five most recent persisted summaries for this tenant,
    // never a full scan of the run store.
    const summaries = await readRunSummaries(session.tenantId, 5);
    const latest = summaries[0] ? await readRun(session.tenantId, summaries[0].id) : null;
    const windowMetrics = {
      runCount: metrics.runCount,
      activeRuns: metrics.activeRuns,
      healed: metrics.healed,
      needsReview: metrics.needsReview,
      successRatePercent: metrics.successRatePercent,
      deliveryFailureRuns: metrics.deliveryFailureRuns,
      timeoutCount: metrics.timeoutCount,
      cancelledCount: metrics.cancelledCount,
      averageDurationMs: metrics.averageDurationMs,
    };
    const summary = buildReportingSummary(
      metrics,
      windowMetrics,
      latest?.verification ?? null,
      parseReportingAssumptions(),
    );
    const recent = summaries
      .map((summary) => notificationEntryFromRun(null, summary))
      .filter((entry): entry is NotificationEntry => entry !== null);
    return NextResponse.json(
      {
        ok: true,
        report: summary,
        recentNotifications: recent,
        sponsorLinks: configuredSponsorLinks(),
      },
      { headers: noStore() },
    );
  } catch (error) {
    return jsonError(error, noStore());
  }
}

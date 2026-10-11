import type { VerificationResult } from "@/lib/types";
import type { ServiceMetrics } from "@/lib/metrics";

// Local snapshot shape mirrors the client-facing metrics strip so the report
// endpoint can reuse the same fields without leaking provider internals.
export interface MetricsSnapshot {
  runCount: number;
  activeRuns: number;
  healed: number;
  needsReview: number;
  successRatePercent: number;
  deliveryFailureRuns: number;
  timeoutCount: number;
  cancelledCount: number;
  averageDurationMs: number | null;
}

// Prompt 9 — honest outcomes/reporting summary.
//
// This is a read-side projection for the dashboard. It is derived only from
// persisted metrics and the finished run's verification result. It does not
// fabricate revenue, measured savings, incident counts, or improvement
// percentages. Any "time or cost avoided" figure is an estimate computed from
// user-supplied assumptions and is labeled as such.

/** User-supplied assumptions for an optional estimated-savings calculation.
 *
 * All values are optional. When absent, the report stays honest and emits no
 * estimated-savings number.
 */
export interface ReportingAssumptions {
  /** Assumed loaded cost per minute of the on-call/operator who would handle the incident. */
  costPerMinute?: number;
  /** Assumed average minutes to diagnose and patch the same failure by hand. */
  manualMinutes?: number;
  /** Optional incident count to scale an estimate across a period. */
  incidentCount?: number;
}

/** Upper bounds that keep a self-reported estimate sane.
 *
 * Values outside these bounds are dropped rather than clamped, so a malformed
 * configuration can never inflate an estimate.
 */
export const REPORTING_LIMITS = {
  costPerMinuteMax: 10_000,
  manualMinutesMax: 10_080, // one week
  incidentCountMax: 100_000,
} as const;

function boundedPositive(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max ? value : null;
}

/** Keep only optional, numeric, finite, positive, bounded assumptions.
 *
 * Anything else is dropped so an estimate can never be built from negative,
 * NaN, infinite, or absurd inputs.
 */
export function sanitizeReportingAssumptions(input: unknown): ReportingAssumptions {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const record = input as Record<string, unknown>;
  const out: ReportingAssumptions = {};
  const costPerMinute = boundedPositive(record.costPerMinute, REPORTING_LIMITS.costPerMinuteMax);
  if (costPerMinute !== null) out.costPerMinute = costPerMinute;
  const manualMinutes = boundedPositive(record.manualMinutes, REPORTING_LIMITS.manualMinutesMax);
  if (manualMinutes !== null) out.manualMinutes = manualMinutes;
  const incidentCount = record.incidentCount;
  if (
    typeof incidentCount === "number" &&
    Number.isInteger(incidentCount) &&
    incidentCount > 0 &&
    incidentCount <= REPORTING_LIMITS.incidentCountMax
  ) {
    out.incidentCount = incidentCount;
  }
  return out;
}

/** Honest reporting summary for the control center. */
export interface ReportingSummary {
  window: MetricsSnapshot;
  metrics: ServiceMetrics;
  estimate: {
    enabled: boolean;
    /** Estimated minutes saved for the selected incident count, or null. */
    minutesSaved: number | null;
    /** Estimated cost saved for the selected incident count, or null. */
    costSaved: number | null;
    assumptions: ReportingAssumptions | null;
    note: string;
  };
}

/** Build a reporting summary from persisted metrics and, optionally, a finished run. */
export function buildReportingSummary(
  metrics: ServiceMetrics,
  window: MetricsSnapshot,
  _latestVerification: VerificationResult | null | undefined,
  rawAssumptions?: ReportingAssumptions,
): ReportingSummary {
  const assumptions = rawAssumptions ? sanitizeReportingAssumptions(rawAssumptions) : null;
  const costPerMinute = assumptions?.costPerMinute;
  const manualMinutes = assumptions?.manualMinutes;
  const incidentCount = assumptions?.incidentCount;
  const enabled = costPerMinute !== undefined && manualMinutes !== undefined;

  let minutesSaved: number | null = null;
  let costSaved: number | null = null;
  let note: string;

  if (enabled && costPerMinute !== undefined && manualMinutes !== undefined) {
    const count = incidentCount ?? Math.max(1, metrics.runCount);
    minutesSaved = Math.round(manualMinutes * count);
    costSaved = Math.round(costPerMinute * manualMinutes * count * 100) / 100;
    note =
      `Estimate across ${count} incident${count === 1 ? "" : "s"} using ${costPerMinute} $/minute and ${manualMinutes} manual minutes. Not a measured saving.`;
  } else {
    note =
      "No estimated-savings figure shown. Set TRACEHEALER_REPORTING_ASSUMPTIONS to enable an explicitly labeled estimate.";
  }

  return {
    window,
    metrics,
    estimate: {
      enabled,
      minutesSaved,
      costSaved,
      assumptions: enabled && assumptions ? assumptions : null,
      note,
    },
  };
}

/** Parse TRACEHEALER_REPORTING_ASSUMPTIONS as JSON into ReportingAssumptions.
 *
 * Unknown keys and out-of-bounds values are dropped. Invalid JSON returns an
 * empty object so the report stays honest rather than throwing at request time.
 */
export function parseReportingAssumptions(): ReportingAssumptions {
  const raw = process.env.TRACEHEALER_REPORTING_ASSUMPTIONS ?? "";
  if (!raw.trim()) return {};
  try {
    return sanitizeReportingAssumptions(JSON.parse(raw));
  } catch {
    return {};
  }
}

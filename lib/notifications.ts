import type { HealResult, RunSummary } from "@/lib/types";

// Prompt 9 — notification & reporting surfaces.
//
// Notification plumbing already exists server-side (notifySlack,
// exportHealedTrace) and is wired through the pipeline in lib/providers.ts.
// This module adds the in-app notification surface for the local/desktop
// control center and a small honest reporting summary.
//
// Optional sponsor/funding support is metadata only: links the dashboard may
// show when configured. There is no payment webhook, no webhook signature
// handling here, and no fabricated integration status.

/** Channels the control center can surface notifications through. */
export const NOTIFICATION_CHANNELS = [
  { id: "in-app" as const, label: "In-app feed", description: "Recent run events shown in the control center." },
  { id: "slack" as const, label: "Slack", description: "Verified-run and delivery notifications via a Slack webhook." },
  { id: "neatlogs" as const, label: "Aftertrace export", description: "Before/after evidence attached to a verified run." },
] as const;

export type NotificationChannelId = (typeof NOTIFICATION_CHANNELS)[number]["id"];

/** A local in-app notification entry derived from a finished run. */
export interface NotificationEntry {
  id: string;
  at: string;
  channel: NotificationChannelId;
  tone: "ok" | "warn" | "bad" | "muted";
  title: string;
  detail: string;
  runId?: string;
  traceId?: string;
}

function entryId(): string {
  return `notif_${Math.random().toString(36).slice(2, 10)}`;
}

/** Map a settled run into the in-app notification feed.
 *
 * Entries are derived only from persisted, authorized run records — never from
 * guessed or synthetic values. When only a summary is available (no full
 * verification record), the detail text says what is actually known instead of
 * reporting a check count that was never read.
 */
export function notificationEntryFromRun(result: HealResult | null, summary?: RunSummary | null): NotificationEntry | null {
  if (!result && !summary) return null;

  const runId = result?.id ?? summary?.id;
  const traceId = result?.traceId ?? summary?.traceId;
  const state = result?.state ?? summary?.state;
  const status = result?.status ?? summary?.status;

  if (state == null) return null;

  const healed = status === "healed";
  const tone: NotificationEntry["tone"] = healed
    ? "ok"
    : state === "delivery-failed" || state === "timed-out"
      ? "bad"
      : state === "cancelled"
        ? "muted"
        : "warn";

  const title = healed
    ? "Verified a fix"
    : state === "delivery-failed"
      ? "Delivery failed"
      : state === "timed-out"
        ? "Run timed out"
        : state === "cancelled"
          ? "Run cancelled"
          : "Needs review";

  const checks = result?.verification?.checks;
  const detail = healed
    ? checks
      ? `${checks.filter((check) => check.status === "passed").length}/${checks.length} checks passed`
      : "Verified fix recorded in the run store"
    : state === "delivery-failed"
      ? "The verified patch could not be delivered"
      : state === "timed-out"
        ? "The run exceeded its timeout before verification finished"
        : state === "cancelled"
          ? "The run was cancelled before a verified fix"
          : "No verified fix was produced";

  return {
    id: entryId(),
    at: result?.completedAt ?? summary?.completedAt ?? new Date().toISOString(),
    channel: "in-app",
    tone,
    title,
    detail,
    runId,
    traceId,
  };
}

/** Optional funding/sponsor links shown when the server is configured.
 *
 * These are display-only links to a project's chosen funding provider. There
 * is no payment processing, no webhook callback, and no status claim attached
 * to them.
 */
export interface SponsorLink {
  id: string;
  provider: string;
  label: string;
  url: string;
}

/** Sponsor links that the dashboard can render when configured.
 *
 * Keep this honest: the empty default means "no sponsor link configured".
 * A deployment can set TRACEHEALER_SPONSOR_LINKS to a JSON array of objects
 * with `provider`, `label`, and `url`.
 */

/** Bounds that keep a deployment-supplied link list safe to render. */
export const SPONSOR_LINK_LIMITS = {
  maxLinks: 5,
  maxProviderLength: 64,
  maxLabelLength: 64,
  maxUrlLength: 2048,
} as const;

/** Return a normalized https URL, or null for any other scheme or an invalid URL.
 *
 * `javascript:`, `data:`, `file:`, `http:`, and unparseable values are all
 * rejected so a configured link can never execute code in the dashboard.
 */
function safeHttpsUrl(value: string): string | null {
  if (value.length > SPONSOR_LINK_LIMITS.maxUrlLength) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

interface RawSponsorLink {
  provider?: unknown;
  label?: unknown;
  url?: unknown;
}

function validSponsorLink(item: RawSponsorLink, index: number): SponsorLink | null {
  if (typeof item.provider !== "string" || typeof item.label !== "string" || typeof item.url !== "string") return null;
  const provider = item.provider.trim();
  const label = item.label.trim();
  if (!provider || provider.length > SPONSOR_LINK_LIMITS.maxProviderLength) return null;
  if (!label || label.length > SPONSOR_LINK_LIMITS.maxLabelLength) return null;
  const url = safeHttpsUrl(item.url.trim());
  if (!url) return null;
  return { id: `sponsor-${index}`, provider, label, url };
}

export function configuredSponsorLinks(): SponsorLink[] {
  const raw = process.env.TRACEHEALER_SPONSOR_LINKS ?? "";
  if (!raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const links: SponsorLink[] = [];
    for (const item of parsed as RawSponsorLink[]) {
      if (links.length >= SPONSOR_LINK_LIMITS.maxLinks) break;
      if (!item || typeof item !== "object") continue;
      const link = validSponsorLink(item, links.length);
      if (link) links.push(link);
    }
    return links;
  } catch {
    return [];
  }
}

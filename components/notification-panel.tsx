"use client";

import { Bell, CheckCircle2, AlertTriangle, XCircle, Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { NotificationEntry, SponsorLink } from "@/lib/notifications";
import type { ReportingSummary } from "@/lib/reporting";

interface ReportPayload {
  ok: boolean;
  report: ReportingSummary;
  recentNotifications: NotificationEntry[];
  sponsorLinks: SponsorLink[];
}

const TONES = ["ok", "warn", "bad", "muted"];
const CHANNELS = ["in-app", "slack", "neatlogs"];

/** Drop malformed notification rows instead of trusting the response shape. */
function sanitizeEntries(value: unknown): NotificationEntry[] {
  if (!Array.isArray(value)) return [];
  const out: NotificationEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || typeof raw.title !== "string" || typeof raw.detail !== "string") continue;
    if (typeof raw.tone !== "string" || !TONES.includes(raw.tone)) continue;
    if (typeof raw.channel !== "string" || !CHANNELS.includes(raw.channel)) continue;
    out.push({
      id: raw.id,
      at: typeof raw.at === "string" ? raw.at : "",
      channel: raw.channel as NotificationEntry["channel"],
      tone: raw.tone as NotificationEntry["tone"],
      title: raw.title,
      detail: raw.detail,
      runId: typeof raw.runId === "string" ? raw.runId : undefined,
      traceId: typeof raw.traceId === "string" ? raw.traceId : undefined,
    });
  }
  return out;
}

/** Keep only well-formed https sponsor links coming back from the server. */
function sanitizeSponsorLinks(value: unknown): SponsorLink[] {
  if (!Array.isArray(value)) return [];
  const out: SponsorLink[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.id !== "string" || typeof raw.provider !== "string" || typeof raw.label !== "string") continue;
    if (typeof raw.url !== "string" || !raw.url.startsWith("https://")) continue;
    out.push({ id: raw.id, provider: raw.provider, label: raw.label, url: raw.url });
  }
  return out;
}

/** Fetch the report with explicit handling for every failure mode the UI shows. */
async function fetchReport(signal: AbortSignal): Promise<ReportPayload> {
  let response: Response;
  try {
    response = await fetch("/api/report", { cache: "no-store", signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    throw new Error(
      offline
        ? "You are offline — notifications will refresh when the connection returns."
        : "Notifications unreachable — the service did not respond.",
    );
  }
  if (response.status === 401) throw new Error("Sign in required — your session is missing or expired.");
  if (response.status === 403) throw new Error("Not authorized to view notifications.");
  if (!response.ok) throw new Error(`Report fetch failed (${response.status})`);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Notifications response was malformed.");
  }
  if (!payload || typeof payload !== "object") throw new Error("Notifications response was malformed.");
  const candidate = payload as Partial<ReportPayload>;
  if (candidate.ok !== true || !Array.isArray(candidate.recentNotifications)) {
    throw new Error("Notifications response was malformed.");
  }
  return {
    ok: true,
    report: candidate.report as ReportingSummary,
    recentNotifications: sanitizeEntries(candidate.recentNotifications),
    sponsorLinks: sanitizeSponsorLinks(candidate.sponsorLinks),
  };
}

export function NotificationBell({ onError }: { onError?: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<NotificationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [sponsorLinks, setSponsorLinks] = useState<SponsorLink[]>([]);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    fetchReport(controller.signal)
      .then((payload) => {
        if (cancelled) return;
        setLoading(false);
        setEntries(payload.recentNotifications.slice(0, 8));
        setSponsorLinks(payload.sponsorLinks);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoading(false);
        if (err instanceof DOMException && err.name === "AbortError") return;
        const message = err instanceof Error ? err.message : "Notifications unavailable";
        setError(message);
        if (onError) onError(message);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [onError]);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node) && triggerRef.current && !triggerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Escape closes the popover and returns focus to the bell so keyboard users
  // are never trapped inside it.
  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  const count = entries.length;
  const toneIcon = (tone: NotificationEntry["tone"]) => {
    switch (tone) {
      case "ok":
        return <CheckCircle2 size={14} strokeWidth={2} />;
      case "bad":
        return <XCircle size={14} strokeWidth={2} />;
      case "warn":
        return <AlertTriangle size={14} strokeWidth={2} />;
      default:
        return <Info size={14} strokeWidth={2} />;
    }
  };

  return (
    <>
      <button
        className="icon-button notification-trigger"
        ref={triggerRef}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Notifications${count ? `, ${count} recent` : ""}`}
        title="Recent run notifications"
      >
        <Bell size={17} />
        {count > 0 ? <span className="notification-dot" aria-hidden="true" /> : null}
      </button>

      {open ? (
        <div
          className="notification-panel"
          ref={panelRef}
          role="dialog"
          aria-label="Recent notifications"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              triggerRef.current?.focus();
            }
          }}
        >
          <div className="notification-panel-head">
            <strong>Notifications</strong>
            <span className="muted-small">Recent run activity</span>
            <button
              className="text-action"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
              aria-label="Close notifications"
            >
              <XCircle size={15} />
            </button>
          </div>

          {loading ? (
            <div className="notification-empty"><span className="spin-dot" aria-hidden="true" /> Loading…</div>
          ) : error ? (
            <div className="notification-empty" role="alert">{error}</div>
          ) : entries.length === 0 ? (
            <div className="notification-empty">No recent notifications.</div>
          ) : (
            <ul className="notification-list" aria-label={`${count} recent notifications`}>
              {entries.map((entry) => (
                <li key={entry.id} className={`notification-item tone-${entry.tone}`}>
                  <span className="notification-icon" aria-hidden="true">{toneIcon(entry.tone)}</span>
                  <div>
                    <strong>{entry.title}</strong>
                    <p>{entry.detail}</p>
                    <small>{entry.at ? new Date(entry.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</small>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {sponsorLinks.length > 0 ? (
            <div className="notification-foot">
              <span className="muted-small">Support TraceHealer</span>
              <div className="sponsor-links">
                {sponsorLinks.map((link) => (
                  <a key={link.id} href={link.url} target="_blank" rel="noreferrer" className="sponsor-link">
                    {link.provider}
                  </a>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

import { agentTraceSchema } from "@/lib/schema";
import type { AgentTrace, TraceSpan } from "@/lib/types";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numeric(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function otelValue(value: unknown): unknown {
  const item = record(value);
  if ("stringValue" in item) return item.stringValue;
  if ("intValue" in item) return numeric(item.intValue);
  if ("doubleValue" in item) return numeric(item.doubleValue);
  if ("boolValue" in item) return Boolean(item.boolValue);
  if ("arrayValue" in item) return record(item.arrayValue).values instanceof Array
    ? (record(item.arrayValue).values as unknown[]).map(otelValue)
    : [];
  return value;
}

function attributes(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .map((item) => record(item))
        .filter((item) => typeof item.key === "string")
        .map((item) => [item.key as string, otelValue(item.value)]),
    );
  }
  return record(value);
}

function nanosToIso(value: unknown) {
  const nanos = numeric(value);
  if (!nanos) return new Date().toISOString();
  return new Date(nanos / 1_000_000).toISOString();
}

function nanosDuration(start: unknown, end: unknown) {
  const startValue = numeric(start);
  const endValue = numeric(end);
  return startValue && endValue ? Math.max(0, Math.round((endValue - startValue) / 1_000_000)) : 0;
}

function statusFromOtel(value: unknown): "ok" | "error" | "running" {
  const status = record(value);
  const code = status.code;
  if (code === 2 || String(code).toUpperCase().includes("ERROR")) return "error";
  if (code === 1 || String(code).toUpperCase().includes("OK")) return "ok";
  return "running";
}

function exceptionFromEvents(value: unknown) {
  if (!Array.isArray(value)) return { error: undefined, stack: undefined };
  for (const candidate of value) {
    const event = record(candidate);
    if (text(event.name).includes("exception")) {
      const attrs = attributes(event.attributes);
      const type = text(attrs["exception.type"]);
      const message = text(attrs["exception.message"]);
      return {
        error: [type, message].filter(Boolean).join(": ") || "Instrumented exception",
        stack: text(attrs["exception.stacktrace"]) || undefined,
      };
    }
  }
  return { error: undefined, stack: undefined };
}

function otelSpan(value: unknown, service: string): TraceSpan {
  const span = record(value);
  const attrs = attributes(span.attributes);
  const exception = exceptionFromEvents(span.events);
  const status = statusFromOtel(span.status);
  return {
    id: text(span.spanId, text(span.id, crypto.randomUUID().slice(0, 16))),
    parentId: text(span.parentSpanId) || undefined,
    name: text(span.name, "unnamed.span"),
    service,
    status: status === "running" && exception.error ? "error" : status,
    startedAt: nanosToIso(span.startTimeUnixNano ?? span.startTime),
    durationMs: nanosDuration(span.startTimeUnixNano ?? span.startTime, span.endTimeUnixNano ?? span.endTime),
    tokens: numeric(attrs["gen_ai.usage.total_tokens"] ?? attrs["llm.usage.total_tokens"]) || undefined,
    costUsd: numeric(attrs["gen_ai.usage.cost"] ?? attrs["llm.cost_usd"]) || undefined,
    error: exception.error ?? (text(attrs["error.message"]) || undefined),
    stack: exception.stack ?? (text(attrs["exception.stacktrace"]) || undefined),
    input: attrs["gen_ai.prompt"] ?? attrs["input.value"],
    output: attrs["gen_ai.completion"] ?? attrs["output.value"],
    attributes: attrs,
  };
}

function fromOtlp(payload: UnknownRecord): AgentTrace | null {
  const resourceSpans = payload.resourceSpans;
  if (!Array.isArray(resourceSpans)) return null;
  const spans: TraceSpan[] = [];
  let resourceAttributes: Record<string, unknown> = {};
  let traceId = "";

  for (const resourceEntry of resourceSpans) {
    const entry = record(resourceEntry);
    resourceAttributes = { ...resourceAttributes, ...attributes(record(entry.resource).attributes) };
    const service = text(resourceAttributes["service.name"], "agent");
    const scopes = (entry.scopeSpans ?? entry.instrumentationLibrarySpans) as unknown;
    if (!Array.isArray(scopes)) continue;
    for (const scopeEntry of scopes) {
      const scope = record(scopeEntry);
      if (!Array.isArray(scope.spans)) continue;
      for (const rawSpan of scope.spans) {
        const source = record(rawSpan);
        traceId ||= text(source.traceId);
        spans.push(otelSpan(source, service));
      }
    }
  }
  if (!spans.length) return null;

  const root = spans.find((span) => !span.parentId) ?? spans[0];
  const durationMs = Math.max(root.durationMs, ...spans.map((span) => span.durationMs));
  const tokens = spans.reduce((total, span) => total + (span.tokens ?? 0), 0);
  const costUsd = spans.reduce((total, span) => total + (span.costUsd ?? 0), 0);
  const hasError = spans.some((span) => span.status === "error");

  return {
    id: traceId || `tr_${crypto.randomUUID().slice(0, 12)}`,
    name: root.name,
    environment: text(resourceAttributes["deployment.environment.name"], text(resourceAttributes["deployment.environment"], "production")),
    repository: text(resourceAttributes["vcs.repository.name"], text(resourceAttributes["service.repository"], "unknown/agent")),
    branch: text(resourceAttributes["vcs.ref.head.name"], "main"),
    commit: text(resourceAttributes["vcs.ref.head.revision"], "unknown"),
    startedAt: root.startedAt,
    durationMs,
    tokens,
    costUsd: Number(costUsd.toFixed(6)),
    status: hasError ? "error" : "success",
    spans,
    metadata: { source: "otlp", resource: resourceAttributes },
  };
}

/** Accepts TraceHealer's native contract, wrapped webhook events, or OTLP JSON. */
export function normalizeTracePayload(payload: unknown): AgentTrace {
  const direct = agentTraceSchema.safeParse(payload);
  if (direct.success) return direct.data;

  const envelope = record(payload);
  if ("trace" in envelope) {
    const wrapped = agentTraceSchema.safeParse(envelope.trace);
    if (wrapped.success) return wrapped.data;
    const wrappedOtlp = fromOtlp(record(envelope.trace));
    if (wrappedOtlp) return agentTraceSchema.parse(wrappedOtlp);
  }

  const otlp = fromOtlp(envelope);
  if (otlp) return agentTraceSchema.parse(otlp);
  return agentTraceSchema.parse(payload);
}

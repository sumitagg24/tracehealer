import type { AgentTrace } from "@/lib/types";

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g, "[REDACTED_TOKEN]"],
  [/\bsk-[A-Za-z0-9]{16,}/g, "[REDACTED_KEY]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [/(?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*["']?[^\s"',]{6,}/gi, "[REDACTED_CREDENTIAL]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]"],
];

/** Remove credentials, tokens, and obvious PII from arbitrary text. */
export function redactSecrets(input: string): string {
  let value = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    value = value.replace(pattern, replacement);
  }
  return value;
}

/**
 * Replace absolute filesystem paths (which leak host/user/layout detail) with a
 * stable placeholder. Repository-relative identifiers are preserved.
 */
export function redactAbsolutePaths(input: string, roots: string[] = []): string {
  let value = input;
  for (const root of roots) {
    if (!root) continue;
    value = value.split(root).join("<data-root>");
    value = value.split(root.replaceAll("\\", "/")).join("<data-root>");
  }
  // Windows drive-letter and POSIX absolute paths.
  value = value.replace(/[A-Za-z]:\\[^\s"'`)]+/g, "<path>");
  value = value.replace(/(?<![\w:\/.])[\/](?:Users|home|tmp|var|app|data)[\/][^\s"'`)]+/g, "<path>");
  return value;
}

export function redactLog(input: string, roots: string[] = []): string {
  return redactAbsolutePaths(redactSecrets(input), roots);
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") {
    const redacted = redactSecrets(value);
    return redacted.length > 500 ? `${redacted.slice(0, 500)}…` : redacted;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => !/secret|token|password|authorization|api[_-]?key/i.test(key))
        .map(([key, item]) => [key, redactValue(item, depth + 1)]),
    );
  }
  return value;
}

/**
 * Produce a bounded, secret-free trace copy safe to send to a model provider.
 * The result is treated as untrusted data by every consumer.
 */
export function redactTraceForModel(trace: AgentTrace): AgentTrace {
  return {
    ...trace,
    spans: trace.spans.map((span) => ({
      ...span,
      input: redactValue(span.input),
      output: redactValue(span.output),
      attributes: span.attributes ? (redactValue(span.attributes) as Record<string, unknown>) : undefined,
    })),
  };
}

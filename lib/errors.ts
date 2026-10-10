/**
 * Typed domain errors with stable codes and a sanitized public message.
 *
 * Internal detail is kept on `detail` for server-side logs and correlation, but
 * `toPublic()` is the only shape ever sent to a client or written to an
 * artifact, so absolute paths, tokens, and raw provider errors never leak.
 */
export type TraceHealerErrorCode =
  | "invalid-input"
  | "invalid-origin"
  | "payload-too-large"
  | "unconfigured"
  | "policy-rejected"
  | "reproduction-failed"
  | "verification-failed"
  | "delivery-failed"
  | "timeout"
  | "cancelled"
  | "duplicate"
  | "not-found"
  | "rate-limited"
  | "internal";

const DEFAULT_STATUS: Record<TraceHealerErrorCode, number> = {
  "invalid-input": 400,
  "invalid-origin": 403,
  "payload-too-large": 413,
  unconfigured: 503,
  "policy-rejected": 422,
  "reproduction-failed": 422,
  "verification-failed": 422,
  "delivery-failed": 502,
  timeout: 504,
  cancelled: 499,
  duplicate: 409,
  "not-found": 404,
  "rate-limited": 429,
  internal: 500,
};

export interface TraceHealerErrorOptions {
  status?: number;
  detail?: unknown;
  cause?: unknown;
}

export class TraceHealerError extends Error {
  readonly code: TraceHealerErrorCode;
  readonly publicMessage: string;
  readonly status: number;
  readonly detail?: unknown;

  constructor(code: TraceHealerErrorCode, publicMessage: string, options: TraceHealerErrorOptions = {}) {
    super(publicMessage, { cause: options.cause });
    this.name = "TraceHealerError";
    this.code = code;
    this.publicMessage = publicMessage;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.detail = options.detail;
  }

  /** Safe for HTTP responses, logs, and artifacts. */
  toPublic(): { code: TraceHealerErrorCode; error: string } {
    return { code: this.code, error: this.publicMessage };
  }
}

export function isTraceHealerError(value: unknown): value is TraceHealerError {
  return value instanceof TraceHealerError;
}

/** Normalizes any thrown value into a typed, safe error. */
export function asTraceHealerError(value: unknown, fallbackMessage = "TraceHealer failed unexpectedly"): TraceHealerError {
  if (isTraceHealerError(value)) return value;
  return new TraceHealerError("internal", fallbackMessage, { cause: value });
}

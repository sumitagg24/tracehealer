import { z } from "zod";

const spanStatusSchema = z.enum(["ok", "error", "running"]);

export const traceSpanSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().optional(),
  name: z.string().min(1),
  service: z.string().default("agent"),
  status: spanStatusSchema,
  startedAt: z.string(),
  durationMs: z.number().nonnegative(),
  tokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  error: z.string().optional(),
  stack: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

export const agentTraceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  environment: z.string().default("production"),
  repository: z.string().default("unknown/agent"),
  branch: z.string().default("main"),
  commit: z.string().default("unknown"),
  startedAt: z.string(),
  durationMs: z.number().nonnegative(),
  tokens: z.number().nonnegative().default(0),
  costUsd: z.number().nonnegative().default(0),
  status: z.enum(["success", "error"]),
  spans: z.array(traceSpanSchema).min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Public mutation contract for starting a healing run.
 *
 * `mode` is required on purpose: an empty body must never silently launch the
 * seeded demo, and connected mode must always carry a real trace. Callers send
 * either `{"mode":"demo"}` or `{"mode":"connected","trace":{...}}`.
 */
export const healRequestSchema = z
  .object({
    trace: agentTraceSchema.optional(),
    mode: z.enum(["demo", "connected"]),
    /** Optional caller-supplied key so retries reuse a run instead of mutating twice. */
    idempotencyKey: z.string().min(8).max(200).optional(),
  })
  .refine((value) => value.mode === "demo" || value.trace !== undefined, {
    message: "A connected run requires a valid trace payload",
    path: ["trace"],
  });

export type HealRequest = z.infer<typeof healRequestSchema>;

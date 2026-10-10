import { TraceHealerError } from "@/lib/errors";
import { assertAllowedPatch } from "@/lib/policy";
import { HEALED_ORDER_SOURCE } from "@/lib/sandbox";
import type { PatchInput, PatchProposal, PatchStrategy } from "@/lib/providers";
import type { DiagnosisCategory } from "@/lib/types";

const DETERMINISTIC_TARGET = "src/order-support.mjs";

/**
 * The trusted zero-secret strategy. It is intentionally narrow: it only claims
 * support for the exact failure shape it can deterministically reproduce, and
 * it returns the reviewed full-file repair for that case. Anything else must
 * fall through to `needs-review`.
 */
export const deterministicStrategy: PatchStrategy = {
  id: "deterministic-order-schema-drift",
  reliable: true,
  supports: ({ trace, diagnosis }) =>
    diagnosis.category === "schema-drift" && trace.spans.some((span) => span.name === "tool.lookup_order"),
  async propose(): Promise<PatchProposal> {
    // The deterministic repair is a reviewed constant for the supported shape.
    return {
      file: DETERMINISTIC_TARGET,
      content: HEALED_ORDER_SOURCE,
      title: "Handle Order API v3 contact schema",
      rationale:
        "Preserve the legacy customer.email contract, support contact.primaryEmail, and replace the retry-triggering TypeError with a typed contract error.",
      language: "javascript",
    };
  },
};

const CATEGORY_PATCH_TITLES: Record<DiagnosisCategory, string> = {
  "schema-drift": "Add a strict upstream contract guard",
  "invalid-json": "Add a bounded JSON parse fallback",
  timeout: "Add an explicit tool deadline and fallback",
  "rate-limit": "Respect upstream backoff before retrying",
  unknown: "Add a bounded recovery path",
};

export interface ModelStrategyOptions {
  /** Injected generator so tests never need network access. */
  generate: (input: { system: string; user: string }) => Promise<string>;
  /** Administrator policy must explicitly enable model-proposed patches. */
  enabled: boolean;
}

/**
 * Optional model-backed strategy. It is never the reliable default: it produces
 * a proposal which the pipeline still validates against repository policy and
 * runs through the identical reproduction/verification gate. Model output is
 * treated strictly as untrusted data.
 */
export function createModelStrategy(options: ModelStrategyOptions): PatchStrategy {
  return {
    id: "model-structured-patch",
    reliable: false,
    supports: () => options.enabled,
    async propose({ diagnosis, context }: PatchInput): Promise<PatchProposal> {
      if (!options.enabled) {
        throw new TraceHealerError("unconfigured", "Model patch strategy is not enabled by policy");
      }
      const raw = await options.generate({
        system:
          "You are a patch generator. Respond with strict JSON: {" +
          '"file": string, "content": string, "title": string, "rationale": string, "language": string}. ' +
          "Only propose changes inside the provided allowlist. Never modify tests, CI, package scripts, or secrets.",
        user: JSON.stringify({
          category: diagnosis.category,
          summary: diagnosis.summary,
          file: diagnosis.file,
          line: diagnosis.line,
          allowlistedFiles: context.filesInspected,
        }),
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new TraceHealerError("verification-failed", "Model returned malformed structured output");
      }

      const record = parsed as Record<string, unknown>;
      const proposal: PatchProposal = {
        file: String(record.file ?? ""),
        content: String(record.content ?? ""),
        title: String(record.title ?? CATEGORY_PATCH_TITLES[diagnosis.category]),
        rationale: String(record.rationale ?? ""),
        language: String(record.language ?? "javascript"),
      };

      if (!proposal.file || !proposal.content) {
        throw new TraceHealerError("verification-failed", "Model proposal was missing a file or content");
      }
      // Policy validation happens before the proposal can reach the sandbox.
      assertAllowedPatch(proposal);
      return proposal;
    },
  };
}

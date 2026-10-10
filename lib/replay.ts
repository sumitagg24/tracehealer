import {
  healedGetCustomerEmail,
  OrderContractError,
  type OrderApiResponse,
  vulnerableGetCustomerEmail,
} from "@/fixtures/demo-agent/order-support";
import type { AgentTrace, VerificationResult } from "@/lib/types";

type Check = VerificationResult["checks"][number];

function timedCheck(name: string, assertion: () => void): Check {
  const startedAt = performance.now();
  try {
    assertion();
    return {
      name,
      status: "passed",
      durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
    };
  } catch {
    return {
      name,
      status: "failed",
      durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
    };
  }
}

function tracedOrderResponse(trace: AgentTrace): OrderApiResponse {
  const lookup = trace.spans.find((span) => span.name === "tool.lookup_order");
  if (!lookup?.output || typeof lookup.output !== "object") {
    throw new Error("The trace does not include the lookup_order output required for replay.");
  }
  return lookup.output as OrderApiResponse;
}

/**
 * Runs real, deterministic code against the exact tool output in the failed
 * trace. This is intentionally isolated from model calls so the hackathon demo
 * remains reproducible even when an external provider is unavailable.
 */
export function runDemoReplay(trace: AgentTrace): Check[] {
  const productionInput = tracedOrderResponse(trace);

  return [
    timedCheck("Replays the exact failed trace input", () => {
      let reproduced = false;
      try {
        vulnerableGetCustomerEmail(productionInput);
      } catch {
        reproduced = true;
      }
      if (!reproduced) throw new Error("The production failure did not reproduce");
      if (healedGetCustomerEmail(productionInput) !== "ada@example.com") {
        throw new Error("The patched function returned the wrong email");
      }
    }),
    timedCheck("Accepts legacy customer.email responses", () => {
      const legacy: OrderApiResponse = {
        order: { id: "legacy", status: "paid", customer: { email: "LEGACY@example.com" } },
      };
      if (healedGetCustomerEmail(legacy) !== "legacy@example.com") throw new Error("Legacy contract broke");
    }),
    timedCheck("Accepts v3 contact.primaryEmail responses", () => {
      const v3: OrderApiResponse = {
        order: { id: "v3", status: "paid", contact: { primaryEmail: "V3@example.com" } },
        apiVersion: "2026-10-01",
      };
      if (healedGetCustomerEmail(v3) !== "v3@example.com") throw new Error("v3 contract broke");
    }),
    timedCheck("Rejects missing email with a typed error", () => {
      const invalid: OrderApiResponse = { order: { id: "invalid", status: "paid" } };
      try {
        healedGetCustomerEmail(invalid);
      } catch (error) {
        if (error instanceof OrderContractError) return;
        throw error;
      }
      throw new Error("Missing email did not produce a typed contract error");
    }),
  ];
}

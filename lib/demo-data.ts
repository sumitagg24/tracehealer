import type { AgentTrace, Incident } from "@/lib/types";

export const DEMO_TRACE: AgentTrace = {
  id: "tr_9f42bc1a",
  name: "support-agent / resolve-order",
  environment: "production",
  repository: "northstar/support-agent",
  branch: "main",
  commit: "8d2f19c",
  startedAt: "2026-10-10T12:47:18.124Z",
  durationMs: 6842,
  tokens: 4280,
  costUsd: 0.0284,
  status: "error",
  metadata: {
    neatlogsProject: "support-agent-prod",
    customerImpact: "checkout-support",
    model: "gpt-5-mini",
  },
  spans: [
    {
      id: "sp_root",
      name: "agent.run",
      service: "support-agent",
      status: "error",
      startedAt: "2026-10-10T12:47:18.124Z",
      durationMs: 6842,
      tokens: 4280,
      costUsd: 0.0284,
      error: "Agent run failed after 3 retries",
      input: { message: "Can you email me the receipt for order #TH-1048?" },
    },
    {
      id: "sp_llm_1",
      parentId: "sp_root",
      name: "llm.plan",
      service: "openai",
      status: "ok",
      startedAt: "2026-10-10T12:47:18.231Z",
      durationMs: 1140,
      tokens: 922,
      costUsd: 0.0061,
      output: { tool: "lookup_order", orderId: "TH-1048" },
    },
    {
      id: "sp_tool",
      parentId: "sp_root",
      name: "tool.lookup_order",
      service: "order-api",
      status: "ok",
      startedAt: "2026-10-10T12:47:19.389Z",
      durationMs: 326,
      input: { orderId: "TH-1048" },
      output: {
        order: {
          id: "TH-1048",
          contact: { primaryEmail: "ada@example.com" },
          status: "paid",
        },
        apiVersion: "2026-10-01",
      },
      attributes: { "http.status_code": 200, "api.version": "v3" },
    },
    {
      id: "sp_parse",
      parentId: "sp_root",
      name: "order.normalize",
      service: "support-agent",
      status: "error",
      startedAt: "2026-10-10T12:47:19.721Z",
      durationMs: 22,
      error: "TypeError: Cannot read properties of undefined (reading 'email')",
      stack:
        "TypeError: Cannot read properties of undefined (reading 'email')\n    at getCustomerEmail (src/order-support.mjs:9:34)\n    at resolveReceiptRequest (src/order-support.mjs:16:16)",
      attributes: { retry: 3, "code.version": "8d2f19c" },
    },
    {
      id: "sp_retry",
      parentId: "sp_root",
      name: "agent.retry-loop",
      service: "support-agent",
      status: "error",
      startedAt: "2026-10-10T12:47:19.751Z",
      durationMs: 5215,
      tokens: 3358,
      costUsd: 0.0223,
      error: "Retry budget exhausted",
      attributes: { attempts: 3 },
    },
  ],
};

export const DEMO_INCIDENT: Incident = {
  id: "inc_2841",
  trace: DEMO_TRACE,
  severity: "critical",
  title: "Order support agent is failing",
  summary:
    "A response schema change in Order API v3 is crashing receipt requests and triggering a costly retry loop.",
  firstSeen: "18 minutes ago",
  affectedRuns: 37,
  status: "open",
  owner: "Support agents",
};

export const BEFORE_SOURCE = `export function getCustomerEmail(response) {
  return response.order.customer.email.toLowerCase();
}`;

export const AFTER_SOURCE = `export function getCustomerEmail(response) {
  const email =
    response.order.customer?.email ??
    response.order.contact?.primaryEmail;

  if (!email) {
    throw new OrderContractError("Order response is missing a customer email");
  }

  return email.toLowerCase();
}`;

export const DEMO_DIFF = `@@ -6,7 +6,15 @@
 export function getCustomerEmail(response) {
-  return response.order.customer.email.toLowerCase();
+  const email =
+    response.order.customer?.email ??
+    response.order.contact?.primaryEmail;
+
+  if (!email) {
+    throw new OrderContractError("Order response is missing a customer email");
+  }
+
+  return email.toLowerCase();
 }`;

import { test, expect, request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { createSession, issueSessionToken, SESSION_COOKIE_NAME } from "@/lib/auth";
import { DEMO_TRACE } from "@/lib/demo-data";
import type { AgentTrace, RunSummary } from "@/lib/types";

/**
 * Browser E2E coverage for the TraceHealer control center.
 *
 * The local server (port 3188) runs the zero-secret `local` auth mode; the
 * session server (port 3189) runs production-style `session` auth so
 * authorization is exercised for real rather than mocked. UI-only auth
 * surfaces are driven with request interception.
 */

const SESSION_SECRET = "e2e-session-secret-32-bytes-minimum!!";
const SESSION_BASE = "http://127.0.0.1:3189";

function sessionCookie(role: "admin" | "operator" | "viewer" = "operator", tenantId = "tenant-e2e"): string {
  const session = createSession({ role, tenantId });
  return `${SESSION_COOKIE_NAME}=${issueSessionToken(session, SESSION_SECRET)}`;
}

/** A trace whose failure classifies as `timeout`, which has no trusted strategy. */
function timeoutTrace(): AgentTrace {
  const trace = structuredClone(DEMO_TRACE);
  // Every failed span must classify as `timeout` so the deterministic
  // schema-drift strategy cannot claim the run.
  for (const span of trace.spans) {
    if (span.status === "error") {
      span.error = "TimeoutError: upstream tool call timed out after 30000 ms";
    }
  }
  return trace;
}

async function waitForTerminal(
  api: APIRequestContext,
  runId: string,
  cookie?: string,
  timeoutMs = 60_000,
): Promise<RunSummary> {
  const started = Date.now();
  const terminal = ["healed", "needs-review", "cancelled", "timed-out"];
  while (Date.now() - started < timeoutMs) {
    const response = await api.get(`/api/runs/${runId}/progress`, {
      headers: cookie ? { cookie } : {},
    });
    if (response.ok()) {
      const payload = (await response.json()) as { summary: RunSummary | null };
      if (payload.summary && terminal.includes(payload.summary.state)) return payload.summary;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`run ${runId} did not settle within ${timeoutMs}ms`);
}

async function startDemoRun(api: APIRequestContext, cookie?: string): Promise<string> {
  const response = await api.post("/api/runs", {
    data: { mode: "demo" },
    headers: cookie ? { cookie } : {},
  });
  expect(response.status()).toBe(202);
  const { runId } = (await response.json()) as { runId: string };
  return runId;
}

test.describe("control center (local development auth)", () => {
  test("loads without a session and reports live service state", async ({ page }) => {
    const health = await page.request.get("/api/health");
    expect(health.status()).toBe(200);

    await page.goto("/");
    await expect(page.getByText("NeatHack Lab").first()).toBeVisible();
    await expect(page.getByText("Persisted runs")).toBeVisible();
    // No authentication wall in local development mode.
    await expect(page.getByRole("alert").filter({ hasText: "Sign in required" })).toHaveCount(0);
  });

  test("runs an explicit demo heal with live progress and verified checks", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Heal this incident" }).first().click();

    // While the server-side run is active the card offers cancellation.
    const healerCard = page.locator(".healer-card");
    await expect(page.getByRole("button", { name: "Cancel run" })).toBeVisible();

    // Server-owned lifecycle, not a client timer: settle on the healed card.
    await expect(healerCard).toHaveClass(/complete/, { timeout: 60_000 });
    await expect(page.getByText("Run settled")).toBeVisible();
    await expect(page.getByText("ALL CHECKS PASSED")).toBeVisible();
    await expect(page.getByText("Patch artifact")).toBeVisible();
    await expect(page.getByText("Verification JSON")).toBeVisible();

    // The proof panel shows the real sandbox exit-code transition.
    await expect(page.getByText(/before exit 1 → after exit 0/)).toBeVisible();
  });

  test("run detail shows timeline, context, checks, metrics, and artifacts", async ({ page, request }) => {
    const runId = await startDemoRun(request);
    await waitForTerminal(request, runId);

    await page.goto("/");
    await page.getByRole("button", { name: /Healing runs/ }).click();
    await page.getByRole("row", { name: new RegExp(runId) }).click();

    await expect(page.getByText("RUN DETAIL", { exact: true })).toBeVisible();
    await expect(page.getByText("Timeline", { exact: true })).toBeVisible();
    await expect(page.getByText("Checks", { exact: true })).toBeVisible();
    await expect(page.getByText("Delivery attempts", { exact: true })).toBeVisible();
    // Real artifacts are downloadable with the right content type.
    const patch = await request.get(`/api/artifacts/${runId}/patch`);
    expect(patch.status()).toBe(200);
    expect(patch.headers()["content-type"]).toContain("text/x-diff");
  });

  test("unsupported failures settle as needs-review, never as a fabricated fix", async ({ page, request }) => {
    const response = await request.post("/api/runs", { data: { mode: "connected", trace: timeoutTrace() } });
    expect(response.status()).toBe(202);
    const { runId } = (await response.json()) as { runId: string };
    const summary = await waitForTerminal(request, runId);
    expect(summary.state).toBe("needs-review");

    await page.goto("/");
    await page.getByRole("button", { name: /Healing runs/ }).click();
    await expect(page.getByRole("row", { name: new RegExp(runId) }).getByText("Needs review")).toBeVisible();
  });

  test("cancellation settles the run as cancelled with no resurrection", async ({ page, request }) => {
    // The demo pipeline takes long enough to cancel mid-flight; retry once if
    // a run settled before the cancel request arrived.
    let cancelledId: string | null = null;
    for (let attempt = 0; attempt < 3 && !cancelledId; attempt += 1) {
      const runId = await startDemoRun(request);
      const cancel = await request.post(`/api/runs/${runId}/cancel`);
      expect(cancel.status()).toBe(200);
      const summary = await waitForTerminal(request, runId);
      if (summary.state === "cancelled") cancelledId = runId;
    }
    expect(cancelledId, "a run must be cancellable while active").not.toBeNull();

    const progress = (await (await request.get(`/api/runs/${cancelledId}/progress`)).json()) as {
      summary: RunSummary | null;
    };
    expect(progress.summary?.state).toBe("cancelled");

    await page.goto("/");
    await page.getByRole("button", { name: /Healing runs/ }).click();
    await expect(page.getByRole("row", { name: new RegExp(cancelledId!) }).getByText("Cancelled")).toBeVisible();
  });

  test("notification popover lists persisted runs and closes with Escape", async ({ page, request }) => {
    const runId = await startDemoRun(request);
    await waitForTerminal(request, runId);

    await page.goto("/");
    const bell = page.locator(".notification-trigger");
    await bell.click();
    const dialog = page.getByRole("dialog", { name: "Recent notifications" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("list")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(bell).toHaveAttribute("aria-expanded", "false");
    // Focus returns to the trigger so keyboard users are never trapped.
    await expect(bell).toBeFocused();
  });

  test("report endpoint stays honest by default", async ({ page }) => {
    const response = await page.request.get("/api/report");
    expect(response.status()).toBe(200);
    const payload = (await response.json()) as {
      ok: boolean;
      report: { estimate: { enabled: boolean; costSaved: number | null; minutesSaved: number | null } };
      recentNotifications: unknown[];
      sponsorLinks: unknown[];
    };
    expect(payload.ok).toBe(true);
    // No fabricated money, savings, or ROI without explicit assumptions.
    expect(payload.report.estimate.enabled).toBe(false);
    expect(payload.report.estimate.costSaved).toBeNull();
    expect(payload.report.estimate.minutesSaved).toBeNull();
    expect(payload.recentNotifications.length).toBeLessThanOrEqual(5);
    expect(payload.sponsorLinks).toEqual([]);
  });

  test("unauthenticated responses render the sign-in surface, not an offline banner", async ({ page }) => {
    const unauthorized = (route: import("@playwright/test").Route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, code: "unauthorized", error: "Authentication required" }),
      });
    // Every session-authenticated endpoint rejects; only the public health
    // probe answers, so the visitor has never had a usable session.
    for (const path of ["/api/runs", "/api/metrics", "/api/integrations", "/api/report"]) {
      await page.route((url) => url.pathname === path || url.pathname.startsWith(`${path}/`), unauthorized);
    }
    await page.goto("/");
    await expect(page.getByRole("alert").filter({ hasText: "Sign in required" })).toBeVisible();
    await expect(page.getByText("The TraceHealer service is unreachable")).toHaveCount(0);
  });

  test("a session rejected mid-use renders the expired-session surface", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Persisted runs")).toBeVisible();

    // The server starts rejecting requests after the initial success.
    await page.route(
      (url) => url.pathname === "/api/runs",
      (route) =>
        route.request().method() === "POST"
          ? route.fulfill({
              status: 401,
              contentType: "application/json",
              body: JSON.stringify({ ok: false, code: "unauthorized", error: "Authentication required" }),
            })
          : route.continue(),
    );
    await page.getByRole("button", { name: "Heal this incident" }).first().click();
    await expect(page.getByRole("alert").filter({ hasText: "Session expired" })).toBeVisible();
  });

  test("responsive layout has no horizontal overflow at any breakpoint", async ({ page }) => {
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      await expect(page.getByText("Persisted runs")).toBeVisible();
      const overflow = await page.evaluate(() => {
        const el = document.scrollingElement;
        return el ? el.scrollWidth - window.innerWidth : 999;
      });
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
    }
  });

  test("every disabled control explains itself and every active control has a name", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Persisted runs")).toBeVisible();
    const problems = await page.evaluate(() => {
      const out: string[] = [];
      for (const button of Array.from(document.querySelectorAll("button"))) {
        const name = (button.textContent ?? "").trim() || button.getAttribute("aria-label") || "";
        if (!name) out.push("button without an accessible name");
        if (button.disabled) {
          const reason = button.getAttribute("title") || button.getAttribute("aria-label");
          if (!reason) out.push(`disabled button without an explanation: ${name}`);
        }
      }
      return out;
    });
    expect(problems).toEqual([]);
  });
});

test.describe("session-authenticated server", () => {
  let api: APIRequestContext;

  test.beforeAll(async () => {
    api = await playwrightRequest.newContext({ baseURL: SESSION_BASE });
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  test("fails closed without a session and enforces role separation", async () => {
    const anonymous = await api.get("/api/runs");
    expect(anonymous.status()).toBe(401);
    expect((await anonymous.json()).code).toBe("unauthorized");

    const operator = sessionCookie("operator");
    const authorized = await api.get("/api/runs", { headers: { cookie: operator } });
    expect(authorized.status()).toBe(200);

    const viewer = sessionCookie("viewer");
    const forbidden = await api.post("/api/runs", {
      data: { mode: "demo" },
      headers: { cookie: viewer },
    });
    expect(forbidden.status()).toBe(403);
    expect((await forbidden.json()).code).toBe("forbidden");
  });

  test("artifact downloads require an authorized, matching tenant", async () => {
    const admin = sessionCookie("admin");
    const runId = await startDemoRun(api, admin);
    await waitForTerminal(api, runId, admin);

    const anonymous = await api.get(`/api/artifacts/${runId}/report`);
    expect(anonymous.status()).toBe(401);

    const authorized = await api.get(`/api/artifacts/${runId}/report`, { headers: { cookie: admin } });
    expect(authorized.status()).toBe(200);
    expect(authorized.headers()["content-type"]).toContain("application/json");

    const foreign = await api.get(`/api/artifacts/${runId}/report`, {
      headers: { cookie: sessionCookie("admin", "tenant-other") },
    });
    expect(foreign.status()).toBe(404);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TraceHealerError } from "@/lib/errors";
import { publishDraftPullRequest, type PullRequestInput } from "@/lib/github";

const ENV_KEYS = [
  "GITHUB_TOKEN",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "GITHUB_BASE_BRANCH",
  "TRACEHEALER_GITHUB_API",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) Reflect.deleteProperty(process.env, key);
    else Object.assign(process.env, { [key]: saved[key] });
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function input(overrides: Partial<PullRequestInput> = {}): PullRequestInput {
  return {
    path: "src/order-support.mjs",
    content: "export const healed = true;\n",
    branch: "tracehealer/heal-abc123",
    title: "Handle Order API v3 contact schema",
    body: "TraceHealer verified repair",
    commitMessage: "Handle Order API v3 contact schema",
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** Stub global fetch with a scripted GitHub API. */
function useGitHub(handler: (call: Call) => { status?: number; body?: unknown } | undefined) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? "GET",
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const scripted = handler(call) ?? { status: 200, body: {} };
      return new Response(
        scripted.body === undefined ? "" : JSON.stringify(scripted.body),
        { status: scripted.status ?? 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return calls;
}

function configure() {
  Object.assign(process.env, {
    GITHUB_TOKEN: "token-value",
    GITHUB_OWNER: "org",
    GITHUB_REPO: "target-agent",
    TRACEHEALER_GITHUB_API: "https://api.github.test",
  });
}

describe("prompt 5 — GitHub draft delivery contract", () => {
  it("creates a draft PR against the configured base branch", async () => {
    configure();
    const calls = useGitHub((call) => {
      if (call.url.endsWith("/git/ref/heads/main")) {
        return { body: { object: { sha: "basesha" } } };
      }
      if (call.url.endsWith("/git/refs")) {
        return { body: { ref: "refs/heads/tracehealer/heal-abc123" } };
      }
      if (call.url.includes("/contents/src%2Forder-support.mjs") || call.url.includes("/contents/src/order-support.mjs")) {
        if (!call.method || call.method === "GET") return { body: { sha: "filesha" } };
        return { body: { commit: { sha: "newsha" } } };
      }
      if (call.method === "POST" && call.url.endsWith("/pulls")) {
        return { body: { number: 42, html_url: "https://github.test/org/target-agent/pull/42" } };
      }
      return undefined;
    });

    const result = await publishDraftPullRequest(input());
    expect(result).toEqual({
      number: 42,
      url: "https://github.test/org/target-agent/pull/42",
      branch: "tracehealer/heal-abc123",
    });

    // The PR is created as a draft, never ready for review or merged.
    const pulls = calls.filter((call) => call.method === "POST" && call.url.endsWith("/pulls"));
    expect(pulls).toHaveLength(1);
    expect((pulls[0].body as { draft: boolean }).draft).toBe(true);
    expect(pulls[0].url).toContain("/org/target-agent/");

    // The branch is pinned to the resolved base sha.
    const ref = calls.find((call) => call.method === "POST" && call.url.endsWith("/git/refs"));
    expect((ref?.body as { sha: string }).sha).toBe("basesha");
  });

  it("is unconfigured without credentials and fails with a typed 503", async () => {
    Reflect.deleteProperty(process.env, "GITHUB_TOKEN");
    Reflect.deleteProperty(process.env, "GITHUB_OWNER");
    Reflect.deleteProperty(process.env, "GITHUB_REPO");
    useGitHub(() => undefined);

    try {
      await publishDraftPullRequest(input());
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TraceHealerError);
      expect((error as TraceHealerError).code).toBe("unconfigured");
      expect((error as TraceHealerError).status).toBe(503);
      expect((error as TraceHealerError).publicMessage).toMatch(/not configured/i);
    }
  });

  it("maps provider failures to typed delivery-failed errors", async () => {
    configure();
    useGitHub((call) => {
      if (call.url.endsWith("/git/ref/heads/main")) return { body: { object: { sha: "x" } } };
      if (call.url.endsWith("/git/refs")) return { status: 422, body: { message: "Reference already exists" } };
      return undefined;
    });

    await expect(publishDraftPullRequest(input())).rejects.toMatchObject({
      code: "delivery-failed",
      status: 502,
    } satisfies Partial<TraceHealerError>);
  });

  it("rejects a base branch that has moved unexpectedly (409 from provider)", async () => {
    configure();
    useGitHub((call) => {
      if (call.url.endsWith("/git/ref/heads/main")) {
        return { status: 404, body: { message: "No commit found for the base branch" } };
      }
      return undefined;
    });

    await expect(publishDraftPullRequest(input())).rejects.toMatchObject({
      code: "delivery-failed",
    });
  });

  it("never claims auto-merge: the body pin explains draft-only delivery", async () => {
    configure();
    const calls = useGitHub((call) => {
      if (call.url.endsWith("/git/ref/heads/main")) return { body: { object: { sha: "b" } } };
      if (call.url.endsWith("/git/refs")) return { body: {} };
      if (call.url.includes("/contents/")) {
        if (!call.method || call.method === "GET") return { body: { sha: "f" } };
        return { body: {} };
      }
      if (call.method === "POST" && call.url.endsWith("/pulls")) {
        return { body: { number: 7, html_url: "https://github.test/pull/7" } };
      }
      return undefined;
    });

    await publishDraftPullRequest(
      input({ body: "TraceHealer verified repair.\n\n> TraceHealer only opens drafts. Human review and merge are required." }),
    );
    const pull = calls.find((call) => call.method === "POST" && call.url.endsWith("/pulls"));
    expect(pull).toBeDefined();
    expect((pull?.body as { draft: boolean }).draft).toBe(true);
    expect(String((pull?.body as { body: string }).body)).toContain("only opens drafts");
  });
});

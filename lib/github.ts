export interface PullRequestInput {
  path: string;
  content: string;
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
}

export interface PullRequestResult {
  number: number;
  url: string;
  branch: string;
}

interface GitHubConfig {
  token: string;
  owner: string;
  repo: string;
  baseBranch: string;
}

function configFromEnvironment(): GitHubConfig | null {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  if (!token || !owner || !repo) return null;
  return {
    token,
    owner,
    repo,
    baseBranch: process.env.GITHUB_BASE_BRANCH ?? "main",
  };
}

async function githubRequest<T>(config: GitHubConfig, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API ${response.status}: ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

/**
 * Publishes an already-verified full-file change as a draft PR. It is kept
 * separate from healTrace so diagnosis and replay cannot accidentally mutate a
 * repository. Callers must place an explicit human approval step in front of
 * this function.
 */
export async function publishDraftPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
  const config = configFromEnvironment();
  if (!config) {
    throw new Error("GitHub publishing is not configured. Set GITHUB_TOKEN, GITHUB_OWNER and GITHUB_REPO.");
  }

  const repoPath = `/repos/${config.owner}/${config.repo}`;
  const baseRef = await githubRequest<{ object: { sha: string } }>(
    config,
    `${repoPath}/git/ref/heads/${encodeURIComponent(config.baseBranch)}`,
  );

  await githubRequest(config, `${repoPath}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: baseRef.object.sha }),
  });

  const currentFile = await githubRequest<{ sha: string }>(
    config,
    `${repoPath}/contents/${input.path}?ref=${encodeURIComponent(config.baseBranch)}`,
  );

  await githubRequest(config, `${repoPath}/contents/${input.path}`, {
    method: "PUT",
    body: JSON.stringify({
      message: input.commitMessage,
      content: Buffer.from(input.content, "utf8").toString("base64"),
      branch: input.branch,
      sha: currentFile.sha,
    }),
  });

  const pullRequest = await githubRequest<{ number: number; html_url: string }>(config, `${repoPath}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      body: input.body,
      head: input.branch,
      base: config.baseBranch,
      draft: true,
    }),
  });

  return { number: pullRequest.number, url: pullRequest.html_url, branch: input.branch };
}

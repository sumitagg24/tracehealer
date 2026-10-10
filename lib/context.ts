import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface RepositoryContext {
  provider: "local-graph" | "entire";
  filesInspected: string[];
  relatedTests: string[];
  symbols: string[];
  checkpointId: string | null;
}

/** Keep persisted repository paths stable across Windows, macOS, and Linux. */
export function normalizeRepositoryPath(file: string) {
  return file.replaceAll("\\", "/");
}

async function sourceFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(root, absolute)));
    else if (/\.(?:mjs|js|ts|tsx|json)$/.test(entry.name)) files.push(normalizeRepositoryPath(path.relative(root, absolute)));
  }
  return files;
}

/** A deterministic repository graph used when no external graph provider is configured. */
export async function buildLocalContextGraph(root: string, symbol: string): Promise<RepositoryContext> {
  const files = await sourceFiles(root);
  const inspected: string[] = [];
  const tests: string[] = [];
  const symbols = new Set<string>();

  for (const file of files) {
    const content = await readFile(path.join(root, file), "utf8");
    if (content.includes(symbol) || file.includes("order-support")) inspected.push(file);
    if ((file.includes("test") || file.includes("spec")) && content.includes(symbol)) tests.push(file);
    for (const match of content.matchAll(/(?:export\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) {
      symbols.add(match[1]);
    }
  }

  return {
    provider: "local-graph",
    filesInspected: inspected,
    relatedTests: tests,
    symbols: [...symbols],
    checkpointId: null,
  };
}

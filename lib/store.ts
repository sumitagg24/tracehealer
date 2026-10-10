import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HealResult, Incident } from "@/lib/types";

function root() {
  return process.env.TRACEHEALER_DATA_DIR ?? path.join(process.cwd(), ".tracehealer-data");
}

async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export async function saveHealingRun(result: HealResult) {
  await atomicJson(path.join(root(), "runs", `${result.id}.json`), result);
}

export async function getHealingRun(id: string): Promise<HealResult | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  try {
    return JSON.parse(await readFile(path.join(root(), "runs", `${id}.json`), "utf8")) as HealResult;
  } catch {
    return null;
  }
}

export async function listHealingRuns(limit = 25): Promise<HealResult[]> {
  const directory = path.join(root(), "runs");
  try {
    const files = (await readdir(directory)).filter((file) => file.endsWith(".json"));
    const values = await Promise.all(
      files.map(async (file) => JSON.parse(await readFile(path.join(directory, file), "utf8")) as HealResult),
    );
    return values
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, Math.max(1, Math.min(limit, 100)));
  } catch {
    return [];
  }
}

export async function saveIncident(incident: Incident) {
  await atomicJson(path.join(root(), "incidents", `${incident.id}.json`), incident);
}

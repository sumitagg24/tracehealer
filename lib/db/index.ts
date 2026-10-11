import path from "node:path";
import { DurableArtifactStore } from "@/lib/artifacts";
import type { SqlDriver } from "@/lib/db/driver";
import { DurableQueue } from "@/lib/db/queue";
import { DurableRunStore } from "@/lib/db/run-store";
import { openSqliteDriver } from "@/lib/db/sqlite";
import { DurableStateStore } from "@/lib/db/state-store";
import type { RunStore } from "@/lib/providers";

/**
 * Persistence factory.
 *
 * `TRACEHEALER_STORE` selects the durable adapter:
 *   - `filesystem` (default): the zero-config JSON/JSONL store in `lib/store.ts`.
 *   - `sqlite`: the transactional store in this directory, which survives
 *     restarts and is shared by every process pointing at the same database
 *     file. A networked database implements the same `SqlDriver` interface.
 */

export type PersistenceDriver = "filesystem" | "sqlite";

export function dataRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRACEHEALER_DATA_DIR ?? path.join(process.cwd(), ".tracehealer-data");
}

export function configuredPersistence(env: NodeJS.ProcessEnv = process.env): PersistenceDriver {
  return env.TRACEHEALER_STORE?.toLowerCase() === "sqlite" ? "sqlite" : "filesystem";
}

export function databaseFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRACEHEALER_DB_FILE ?? path.join(dataRoot(env), "tracehealer.db");
}

export interface DurableStack {
  driver: SqlDriver;
  state: DurableStateStore;
  queue: DurableQueue;
  artifacts: DurableArtifactStore;
  persistence: { driver: string; dialect: string; schemaVersion: number; databaseFile: string };
}

let cached: Promise<DurableStack> | null = null;

/** Open (once per process) the durable stack for the configured adapter. */
export async function openDurableStack(
  env: NodeJS.ProcessEnv = process.env,
  options: { now?: () => Date } = {},
): Promise<DurableStack> {
  const file = databaseFile(env);
  const driver = await openSqliteDriver(file);
  const state = await DurableStateStore.open(driver, options);
  return {
    driver,
    state,
    queue: new DurableQueue(driver, options),
    artifacts: new DurableArtifactStore(driver, { dataRoot: dataRoot(env), now: options.now }),
    persistence: {
      driver: driver.driver,
      dialect: driver.dialect,
      schemaVersion: state.schemaVersion,
      databaseFile: file,
    },
  };
}

/** Memoized stack so routes reuse one connection instead of opening per request. */
export function getDurableStack(): Promise<DurableStack> {
  if (!cached) {
    cached = openDurableStack().catch((error) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}

/** The durable stack, or null when the filesystem adapter is configured. */
export async function getDurableStackIfEnabled(): Promise<DurableStack | null> {
  if (configuredPersistence() !== "sqlite") return null;
  return getDurableStack();
}

/**
 * Tenant-bound `RunStore` over the durable store, or null when the filesystem
 * adapter is configured (the caller then uses the filesystem store).
 */
export async function runStoreFor(tenantId: string): Promise<RunStore | null> {
  const stack = await getDurableStackIfEnabled();
  if (!stack) return null;
  return new DurableRunStore(stack.state, tenantId);
}

/** Drop the memoized stack, closing its connection. Used by tests and shutdown. */
export async function resetDurableStack(): Promise<void> {
  const pending = cached;
  cached = null;
  if (!pending) return;
  const stack = await pending.catch(() => null);
  if (stack) await stack.driver.close().catch(() => undefined);
}

/** Dependency probe used by the readiness endpoint. */
export async function durableHealth(): Promise<{
  driver: string;
  ok: boolean;
  schemaVersion: number;
} | null> {
  const stack = await getDurableStackIfEnabled();
  if (!stack) return null;
  const health = await stack.state.health();
  return { driver: health.driver, ok: health.ok, schemaVersion: health.schemaVersion };
}

export { DurableArtifactStore, DurableQueue, DurableStateStore };
export type { SqlDriver };

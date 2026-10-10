import { runStoreFor } from "@/lib/db";
import { filesystemRunStore, type RunStore } from "@/lib/providers";
import type { HealResult, RunSummary } from "@/lib/types";

/**
 * Tenant-aware run access.
 *
 * Every route and coordinator call goes through here, so switching
 * `TRACEHEALER_STORE` moves reads *and* writes together: there is exactly one
 * source of truth per deployment instead of two half-populated stores.
 */

export async function runStoreForTenant(tenantId: string): Promise<RunStore> {
  const durable = await runStoreFor(tenantId);
  return durable ?? filesystemRunStore;
}

export async function readRun(tenantId: string, id: string): Promise<HealResult | null> {
  const store = await runStoreForTenant(tenantId);
  return store.getRun(id);
}

export async function readRunSummaries(tenantId: string, limit = 100): Promise<RunSummary[]> {
  const store = await runStoreForTenant(tenantId);
  return store.listSummaries(limit);
}

export async function readHealingRuns(tenantId: string, limit = 25): Promise<HealResult[]> {
  const store = await runStoreForTenant(tenantId);
  return store.listRuns(limit);
}

export async function readRunSummary(tenantId: string, id: string): Promise<RunSummary | null> {
  const store = await runStoreForTenant(tenantId);
  return store.getSummary(id);
}

export async function readRunEvents(tenantId: string, id: string) {
  const store = await runStoreForTenant(tenantId);
  return store.readEvents(id);
}

export async function saveRunForTenant(tenantId: string, result: HealResult): Promise<void> {
  const store = await runStoreForTenant(tenantId);
  await store.saveRun(result);
}

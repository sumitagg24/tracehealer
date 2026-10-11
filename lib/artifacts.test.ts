import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DurableArtifactStore } from "@/lib/artifacts";
import { openSqliteDriver } from "@/lib/db/sqlite";
import { DurableStateStore } from "@/lib/db/state-store";
import { TraceHealerError } from "@/lib/errors";

const dirs: string[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "th-artifacts-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

async function harness(root?: string, now?: () => Date) {
  const dataRoot = root ?? (await tempRoot());
  const driver = await openSqliteDriver(path.join(dataRoot, "tracehealer.db"));
  await DurableStateStore.open(driver, now ? { now } : {});
  return { store: new DurableArtifactStore(driver, { dataRoot, now }), dataRoot, close: () => driver.close() };
}

describe("prompt 3 — artifact store adapter", () => {
  it("stores a blob with a digest and reads it back per tenant", async () => {
    const h = await harness();
    const meta = await h.store.put({
      tenantId: "tenant-a",
      runId: "heal_art1",
      kind: "patch",
      content: "--- a/src/order-support.mjs\n+++ b/src/order-support.mjs\n",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(meta.relPath).toBe("artifacts/heal_art1/change.patch");
    expect(meta.contentType).toContain("text/x-diff");
    expect(meta.bytes).toBeGreaterThan(0);
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/);

    const blob = await h.store.get("tenant-a", "heal_art1", "patch");
    expect(blob?.content).toContain("order-support.mjs");
    expect(blob?.sha256).toBe(meta.sha256);

    // Tenant scoping: another tenant sees nothing, and neither does a wrong kind.
    expect(await h.store.get("tenant-b", "heal_art1", "patch")).toBeNull();
    expect(await h.store.head("tenant-b", "heal_art1", "patch")).toBeNull();
    expect(await h.store.get("tenant-a", "heal_art1", "report")).toBeNull();

    // The bytes really are on disk under the data root.
    const onDisk = await readFile(
      path.join(h.dataRoot, "artifacts", "heal_art1", "change.patch"),
      "utf8",
    );
    expect(onDisk).toContain("order-support.mjs");
    await h.close();
  });

  it("refuses unsafe identifiers and traversal attempts", async () => {
    const h = await harness();
    for (const runId of ["../escape", "a/b", "..", ""]) {
      await expect(
        h.store.put({ tenantId: "tenant-a", runId, kind: "patch", content: "x" }),
      ).rejects.toThrow(TraceHealerError);
    }
    expect(await h.store.get("tenant-a", "../escape", "patch")).toBeNull();
    expect(await h.store.head("tenant-a", "heal_x", "patch")).toBeNull();
    expect(await h.store.remove("tenant-a", "../escape", "patch")).toBe(false);
    await h.close();
  });

  it("indexes a blob another writer already placed on disk", async () => {
    const h = await harness();
    await mkdir(path.join(h.dataRoot, "artifacts", "heal_written"), { recursive: true });
    await writeFile(
      path.join(h.dataRoot, "artifacts", "heal_written", "verification.json"),
      JSON.stringify({ passed: true }),
      "utf8",
    );

    const meta = await h.store.register({ tenantId: "tenant-a", runId: "heal_written", kind: "report" });
    expect(meta?.bytes).toBe(JSON.stringify({ passed: true }).length);
    expect((await h.store.get("tenant-a", "heal_written", "report"))?.content).toContain("passed");
    expect(await h.store.register({ tenantId: "tenant-a", runId: "heal_missing", kind: "report" })).toBeNull();
    await h.close();
  });

  it("pages and prunes tenant-scoped artifacts", async () => {
    const h = await harness();
    for (let index = 0; index < 4; index += 1) {
      await h.store.put({
        tenantId: "tenant-a",
        runId: `heal_p${index}`,
        kind: "report",
        content: `{"n":${index}}`,
        createdAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      });
    }
    await h.store.put({
      tenantId: "tenant-b",
      runId: "heal_other",
      kind: "report",
      content: "{}",
      createdAt: "2026-02-01T00:00:00.000Z",
    });

    const page1 = await h.store.list("tenant-a", { limit: 2 });
    expect(page1.items.map((item) => item.runId)).toEqual(["heal_p3", "heal_p2"]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await h.store.list("tenant-a", { limit: 2, cursor: page1.nextCursor });
    expect(page2.items.map((item) => item.runId)).toEqual(["heal_p1", "heal_p0"]);
    expect(page2.nextCursor).toBeNull();

    // Only tenant-a's two oldest artifacts age out, and tenant-b's are untouched.
    expect(await h.store.prune("tenant-a", "2026-01-03T00:00:00.000Z")).toBe(2);
    const remaining = await h.store.list("tenant-a");
    expect(remaining.items.map((item) => item.runId)).toEqual(["heal_p3", "heal_p2"]);
    expect(await h.store.get("tenant-b", "heal_other", "report")).not.toBeNull();

    expect(await h.store.remove("tenant-b", "heal_other", "report")).toBe(true);
    expect(await h.store.remove("tenant-b", "heal_other", "report")).toBe(false);
    await h.close();
  });

  it("fails loudly when the blob cannot be written and records no metadata", async () => {
    const h = await harness();
    // A directory where the blob file must go makes the write fail.
    await mkdir(path.join(h.dataRoot, "artifacts", "heal_broken", "change.patch"), { recursive: true });

    await expect(
      h.store.put({ tenantId: "tenant-a", runId: "heal_broken", kind: "patch", content: "x" }),
    ).rejects.toThrow(/Artifact could not be written/);

    expect(await h.store.head("tenant-a", "heal_broken", "patch")).toBeNull();
    expect((await h.store.list("tenant-a")).items).toEqual([]);
    await h.close();
  });

  it("keeps artifact metadata durable across a restart", async () => {
    const dataRoot = await tempRoot();
    const first = await harness(dataRoot, () => new Date("2026-03-01T00:00:00.000Z"));
    await first.store.put({
      tenantId: "tenant-a",
      runId: "heal_persist",
      kind: "log",
      content: "TAP version 13\n",
    });
    await first.close();

    const second = await harness(dataRoot);
    const meta = await second.store.head("tenant-a", "heal_persist", "log");
    expect(meta?.createdAt).toBe("2026-03-01T00:00:00.000Z");
    expect((await second.store.get("tenant-a", "heal_persist", "log"))?.content).toContain("TAP version 13");
    await second.close();
  });
});

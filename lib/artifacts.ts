import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SqlDriver } from "@/lib/db/driver";
import { TraceHealerError } from "@/lib/errors";

/**
 * Artifact store adapter.
 *
 * Blobs live in the data root (an object store can implement the same interface)
 * while their metadata — tenant, kind, size, digest, creation time — lives in the
 * transactional database. That split gives tenant-scoped listing, keyset
 * pagination, retention, and deletion without giving up the simple filesystem
 * layout the download endpoints already serve.
 */

export type ArtifactKind = "patch" | "report" | "log";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ["patch", "report", "log"];

const FILE_NAMES: Record<ArtifactKind, string> = {
  patch: "change.patch",
  report: "verification.json",
  log: "run.log",
};

const CONTENT_TYPES: Record<ArtifactKind, string> = {
  patch: "text/x-diff; charset=utf-8",
  report: "application/json; charset=utf-8",
  log: "text/plain; charset=utf-8",
};

export interface ArtifactMeta {
  runId: string;
  tenantId: string;
  kind: ArtifactKind;
  /** Data-root-relative path, safe to persist and display. */
  relPath: string;
  contentType: string;
  bytes: number;
  sha256: string;
  createdAt: string;
}

export interface ArtifactBlob extends ArtifactMeta {
  content: string;
}

export interface ArtifactPage {
  items: ArtifactMeta[];
  nextCursor: string | null;
}

export interface PutArtifactInput {
  tenantId: string;
  runId: string;
  kind: ArtifactKind;
  content: string;
  contentType?: string;
  createdAt?: string;
}

export interface ArtifactStore {
  put(input: PutArtifactInput): Promise<ArtifactMeta>;
  /** Index a blob that another writer already placed on disk. */
  register(input: { tenantId: string; runId: string; kind: ArtifactKind }): Promise<ArtifactMeta | null>;
  get(tenantId: string, runId: string, kind: ArtifactKind): Promise<ArtifactBlob | null>;
  head(tenantId: string, runId: string, kind: ArtifactKind): Promise<ArtifactMeta | null>;
  list(tenantId: string, options?: { limit?: number; cursor?: string | null }): Promise<ArtifactPage>;
  remove(tenantId: string, runId: string, kind: ArtifactKind): Promise<boolean>;
  prune(tenantId: string, before: string): Promise<number>;
  isKind(value: string): value is ArtifactKind;
}

export function isArtifactKind(value: string): value is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(value);
}

export function artifactContentType(kind: ArtifactKind): string {
  return CONTENT_TYPES[kind];
}

/** Only a conservative identifier shape may reach the filesystem. */
export function isSafeArtifactId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,80}$/.test(id);
}

interface ArtifactRow {
  run_id: string;
  tenant_id: string;
  kind: string;
  rel_path: string;
  content_type: string;
  bytes: number;
  sha256: string;
  created_at: string;
}

function toMeta(row: ArtifactRow): ArtifactMeta {
  return {
    runId: row.run_id,
    tenantId: row.tenant_id,
    kind: row.kind as ArtifactKind,
    relPath: row.rel_path,
    contentType: row.content_type,
    bytes: Number(row.bytes),
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

export class DurableArtifactStore implements ArtifactStore {
  private readonly artifactRoot: string;
  private readonly now: () => Date;

  constructor(
    private readonly driver: SqlDriver,
    options: { dataRoot: string; now?: () => Date },
  ) {
    this.artifactRoot = path.resolve(path.join(options.dataRoot, "artifacts"));
    this.now = options.now ?? (() => new Date());
  }

  isKind(value: string): value is ArtifactKind {
    return isArtifactKind(value);
  }

  /**
   * Resolve a blob path, refusing anything that escapes the artifact root. Shared
   * by every read and write so traversal cannot be introduced by a new call site.
   */
  private resolvePath(runId: string, kind: ArtifactKind): string {
    if (!isSafeArtifactId(runId) || !isArtifactKind(kind)) {
      throw new TraceHealerError("invalid-input", "Unsafe artifact identifier");
    }
    const target = path.resolve(path.join(this.artifactRoot, runId, FILE_NAMES[kind]));
    const relative = path.relative(this.artifactRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new TraceHealerError("invalid-input", "Artifact path escapes the store root");
    }
    return target;
  }

  private async writeMeta(meta: ArtifactMeta): Promise<void> {
    await this.driver.execute(
      `INSERT INTO artifacts (run_id, tenant_id, kind, rel_path, content_type, bytes, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, kind) DO UPDATE SET tenant_id = excluded.tenant_id,
                                               rel_path = excluded.rel_path,
                                               content_type = excluded.content_type,
                                               bytes = excluded.bytes,
                                               sha256 = excluded.sha256,
                                               created_at = excluded.created_at`,
      [meta.runId, meta.tenantId, meta.kind, meta.relPath, meta.contentType, meta.bytes, meta.sha256, meta.createdAt],
    );
  }

  async put(input: PutArtifactInput): Promise<ArtifactMeta> {
    const target = this.resolvePath(input.runId, input.kind);
    const meta: ArtifactMeta = {
      runId: input.runId,
      tenantId: input.tenantId,
      kind: input.kind,
      relPath: `artifacts/${input.runId}/${FILE_NAMES[input.kind]}`,
      contentType: input.contentType ?? CONTENT_TYPES[input.kind],
      bytes: Buffer.byteLength(input.content, "utf8"),
      sha256: createHash("sha256").update(input.content, "utf8").digest("hex"),
      createdAt: input.createdAt ?? this.now().toISOString(),
    };

    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, input.content, "utf8");
    } catch (error) {
      throw new TraceHealerError("internal", "Artifact could not be written", { cause: error });
    }

    try {
      await this.writeMeta(meta);
    } catch (error) {
      // Never leave an unindexed blob behind: an orphaned file would be
      // downloadable but invisible to retention and tenant scoping.
      await rm(target, { force: true }).catch(() => undefined);
      throw new TraceHealerError("internal", "Artifact metadata could not be recorded", { cause: error });
    }
    return meta;
  }

  async register(input: { tenantId: string; runId: string; kind: ArtifactKind }): Promise<ArtifactMeta | null> {
    let target: string;
    try {
      target = this.resolvePath(input.runId, input.kind);
    } catch {
      return null;
    }
    let info: { size: number };
    let content: Buffer;
    try {
      info = await stat(target);
      content = await readFile(target);
    } catch {
      return null;
    }
    const meta: ArtifactMeta = {
      runId: input.runId,
      tenantId: input.tenantId,
      kind: input.kind,
      relPath: `artifacts/${input.runId}/${FILE_NAMES[input.kind]}`,
      contentType: CONTENT_TYPES[input.kind],
      bytes: Number(info.size),
      sha256: createHash("sha256").update(content).digest("hex"),
      createdAt: this.now().toISOString(),
    };
    await this.writeMeta(meta);
    return meta;
  }

  async head(tenantId: string, runId: string, kind: ArtifactKind): Promise<ArtifactMeta | null> {
    const row = await this.driver.queryOne<ArtifactRow>(
      "SELECT * FROM artifacts WHERE run_id = ? AND tenant_id = ? AND kind = ?",
      [runId, tenantId, kind],
    );
    return row ? toMeta(row) : null;
  }

  async get(tenantId: string, runId: string, kind: ArtifactKind): Promise<ArtifactBlob | null> {
    const meta = await this.head(tenantId, runId, kind);
    if (!meta) return null;
    try {
      const content = await readFile(this.resolvePath(runId, kind), "utf8");
      return { ...meta, content };
    } catch {
      return null;
    }
  }

  async list(
    tenantId: string,
    options: { limit?: number; cursor?: string | null } = {},
  ): Promise<ArtifactPage> {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
    const params: Array<string | number> = [tenantId];
    let where = "WHERE tenant_id = ?";
    if (options.cursor) {
      const [createdAt, runId, kind] = String(options.cursor).split("|");
      if (createdAt && runId && kind) {
        where +=
          " AND (created_at < ? OR (created_at = ? AND (run_id < ? OR (run_id = ? AND kind < ?))))";
        params.push(createdAt, createdAt, runId, runId, kind);
      }
    }
    params.push(limit + 1);
    const rows = await this.driver.query<ArtifactRow>(
      `SELECT * FROM artifacts ${where} ORDER BY created_at DESC, run_id DESC, kind DESC LIMIT ?`,
      params,
    );
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toMeta);
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? `${last.createdAt}|${last.runId}|${last.kind}` : null };
  }

  async remove(tenantId: string, runId: string, kind: ArtifactKind): Promise<boolean> {
    const meta = await this.head(tenantId, runId, kind);
    if (!meta) return false;
    await this.driver.execute("DELETE FROM artifacts WHERE run_id = ? AND tenant_id = ? AND kind = ?", [
      runId,
      tenantId,
      kind,
    ]);
    await rm(this.resolvePath(runId, kind), { force: true }).catch(() => undefined);
    return true;
  }

  /** Retention: drop blobs created before `before`. */
  async prune(tenantId: string, before: string): Promise<number> {
    const rows = await this.driver.query<ArtifactRow>(
      "SELECT * FROM artifacts WHERE tenant_id = ? AND created_at < ?",
      [tenantId, before],
    );
    let removed = 0;
    for (const row of rows) {
      if (await this.remove(tenantId, row.run_id, row.kind as ArtifactKind)) removed += 1;
    }
    return removed;
  }
}

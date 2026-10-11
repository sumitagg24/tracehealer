import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHECKSUM_FILE_NAME,
  assertNoDuplicatePaths,
  collectInstallerFiles,
  generateChecksumFile,
  hashFileStream,
  main,
} from "./generate-release-checksums.mjs";

const created: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

async function write(dir: string, relative: string, content: string): Promise<string> {
  const target = path.join(dir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return target;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// Symlink creation needs elevation on a default Windows host, so the symlink test
// is skipped there instead of silently passing.
const canCreateSymlinks = (() => {
  try {
    const probe = path.join(tmpdir(), `th-symlink-probe-${process.pid}`);
    symlinkSync(probe, `${probe}-link`);
    return true;
  } catch {
    return false;
  }
})();

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe("release checksum generator", () => {
  it("collects only installer extensions, recursively, in a deterministic order", async () => {
    const dir = await tempDir("th-checksums-collect-");
    await write(dir, "zeta.deb", "z");
    await write(dir, "Alpha.msi", "a");
    await write(dir, "app.exe", "e");
    await write(dir, "UPPER.EXE", "u");
    // Not installers: must never appear in the checksum file.
    await write(dir, "notes.txt", "n");
    await write(dir, "lib.so", "s");
    await write(dir, CHECKSUM_FILE_NAME, "stale");
    await write(dir, "nested/deep/thing.dmg", "d");
    await write(dir, "nested/bundle.AppImage", "i");

    const entries = await collectInstallerFiles(dir);

    expect(entries.map((entry) => entry.relativePath)).toEqual([
      "Alpha.msi",
      "UPPER.EXE",
      "app.exe",
      "nested/bundle.AppImage",
      "nested/deep/thing.dmg",
      "zeta.deb",
    ]);
  });

  it("writes relative / paths and digests that match node's own sha256", async () => {
    const dir = await tempDir("th-checksums-write-");
    await write(dir, "TraceHealer_0.1.0_x64_en-US.msi", "msi-bytes");
    await write(dir, "linux/TraceHealer_0.1.0_amd64.deb", "deb-bytes");

    const { outputPath, content } = await generateChecksumFile(dir);

    expect(path.basename(outputPath)).toBe(CHECKSUM_FILE_NAME);
    expect(content).toBe(
      `${sha256("msi-bytes")}  TraceHealer_0.1.0_x64_en-US.msi\n` +
        `${sha256("deb-bytes")}  linux/TraceHealer_0.1.0_amd64.deb\n`,
    );
    // Two spaces between digest and path, POSIX separators, no absolute path.
    expect(content).not.toMatch(/\\/);
    expect(content).not.toContain(dir);
    expect(await readFile(outputPath, "utf8")).toBe(content);
  });

  it("never lists its own file, and stays byte-identical across runs", async () => {
    const dir = await tempDir("th-checksums-idempotent-");
    await write(dir, "TraceHealer_0.1.0_x64-setup.exe", "setup");

    const first = await generateChecksumFile(dir);
    const second = await generateChecksumFile(dir);

    expect(second.content).toBe(first.content);
    expect(first.content).not.toContain(CHECKSUM_FILE_NAME);
    expect(first.content.endsWith("\n")).toBe(true);
    expect((await collectInstallerFiles(dir)).map((entry) => entry.relativePath)).toEqual([
      "TraceHealer_0.1.0_x64-setup.exe",
    ]);
  });

  it("produces the same bytes regardless of the order files were created", async () => {
    const names = ["TraceHealer_0.1.0_x64_en-US.msi", "TraceHealer_0.1.0_universal.dmg"];
    const forward = await tempDir("th-checksums-order-a-");
    const reverse = await tempDir("th-checksums-order-b-");

    for (const name of names) {
      await write(forward, name, `payload-${name}`);
    }
    for (const name of [...names].reverse()) {
      await write(reverse, name, `payload-${name}`);
    }

    const a = await generateChecksumFile(forward);
    const b = await generateChecksumFile(reverse);
    expect(a.content).toBe(b.content);
  });

  it("hashes large files by streaming, not by buffering them", async () => {
    const dir = await tempDir("th-checksums-stream-");
    const payload = "buffer-me".repeat(200_000);
    const file = await write(dir, "TraceHealer_0.1.0_amd64.AppImage", payload);

    expect(await hashFileStream(file)).toBe(sha256(payload));
  });

  it("fails when no installer files are found", async () => {
    const dir = await tempDir("th-checksums-empty-");
    await write(dir, "only-notes.txt", "n");

    await expect(collectInstallerFiles(dir)).rejects.toThrow(/no installer files found/);
    await expect(generateChecksumFile(dir)).rejects.toThrow(/expected at least one of/);
  });

  it("fails when the artifact directory does not exist", async () => {
    const missing = path.join(tmpdir(), `th-checksums-missing-${process.pid}-${Date.now()}`);
    await expect(collectInstallerFiles(missing)).rejects.toThrow(/cannot read artifact directory/);
  });

  it("fails on duplicate or case-colliding normalized paths", () => {
    expect(() =>
      assertNoDuplicatePaths([
        { relativePath: "a/TraceHealer.msi", absolutePath: "/one/TraceHealer.msi" },
        { relativePath: "a/TraceHealer.msi", absolutePath: "/two/TraceHealer.msi" },
      ]),
    ).toThrow(/duplicate installer path/);

    // Windows and macOS artifact downloads are case-insensitive, so a case-only
    // difference is a real collision rather than a distinct installer.
    expect(() =>
      assertNoDuplicatePaths([
        { relativePath: "TraceHealer.msi", absolutePath: "/one/TraceHealer.msi" },
        { relativePath: "tracehealer.msi", absolutePath: "/two/tracehealer.msi" },
      ]),
    ).toThrow(/duplicate installer path/);

    expect(() =>
      assertNoDuplicatePaths([
        { relativePath: "TraceHealer.msi", absolutePath: "/one/TraceHealer.msi" },
        { relativePath: "TraceHealer.deb", absolutePath: "/one/TraceHealer.deb" },
      ]),
    ).not.toThrow();
  });

  it.skipIf(!canCreateSymlinks)("ignores symlinked directories and refuses a symlinked installer", async () => {
    const dir = await tempDir("th-checksums-symlink-");
    const outside = await tempDir("th-checksums-outside-");
    await write(outside, "TraceHealer_0.1.0_x64_en-US.msi", "outside");
    await write(dir, "TraceHealer_0.1.0_amd64.deb", "inside");

    await symlink(outside, path.join(dir, "linked-outside"), "dir");
    // A directory symlink is skipped, so the outside MSI is not hashed.
    expect((await collectInstallerFiles(dir)).map((entry) => entry.relativePath)).toEqual([
      "TraceHealer_0.1.0_amd64.deb",
    ]);

    await symlink(
      path.join(outside, "TraceHealer_0.1.0_x64_en-US.msi"),
      path.join(dir, "TraceHealer_0.1.0_x64-setup.exe"),
    );
    await expect(collectInstallerFiles(dir)).rejects.toThrow(
      /refusing to follow symlinked installer/,
    );
  });

  it("prints usage and fails when no artifact directory is given", async () => {
    const code = await main([]);
    expect(code).toBe(1);
  });
});

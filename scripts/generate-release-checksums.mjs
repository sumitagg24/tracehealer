#!/usr/bin/env node
// Deterministic SHA256SUMS.txt generator for the final desktop installer bundles.
//
// Why this exists: the desktop workflow used to checksum the *raw* release
// binaries sitting next to the build output (and needed a `shell: bash` special
// case so PowerShell would not try to parse the bash loop). That produced no
// checksum at all for the files a user actually downloads. This script runs once,
// after every platform's bundle has been downloaded into one directory, so the
// checksums always describe the published installers and nothing else.
//
// Usage: node scripts/generate-release-checksums.mjs <artifact-dir> [output-file]

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

/** Final installer extensions, compared case-insensitively. */
export const SUPPORTED_INSTALLER_EXTENSIONS = Object.freeze([
  ".msi",
  ".exe",
  ".dmg",
  ".appimage",
  ".deb",
]);

export const CHECKSUM_FILE_NAME = "SHA256SUMS.txt";

function isSupportedInstaller(name) {
  return SUPPORTED_INSTALLER_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

// Byte-wise comparison, so the ordering is identical on every platform and does
// not depend on the runner's locale.
function comparePaths(a, b) {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

async function walk(dir, relative, found) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code ?? "unknown error";
    throw new Error(`cannot read artifact directory "${relative || dir}": ${code}`);
  }

  for (const entry of entries) {
    const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;

    // Never follow a symlink. It can point outside the artifact directory, and a
    // symlinked "installer" would hash a file this release did not publish.
    if (entry.isSymbolicLink()) {
      if (isSupportedInstaller(entry.name)) {
        throw new Error(`refusing to follow symlinked installer "${entryRelative}"`);
      }
      continue;
    }

    if (entry.isDirectory()) {
      await walk(path.join(dir, entry.name), entryRelative, found);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    // The checksum file is never one of its own inputs.
    if (entry.name === CHECKSUM_FILE_NAME || !isSupportedInstaller(entry.name)) {
      continue;
    }

    found.push({
      relativePath: entryRelative,
      absolutePath: path.join(dir, entry.name),
    });
  }
}

/**
 * Fails when two entries would resolve to the same checksum line. Paths are
 * compared case-insensitively because two artifacts that differ only by case
 * collide on Windows and macOS runners, which is exactly how a merged artifact
 * directory silently loses a file.
 */
export function assertNoDuplicatePaths(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const key = entry.relativePath.toLowerCase();
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new Error(
        `duplicate installer path "${entry.relativePath}" collides with "${previous}"`,
      );
    }
    seen.set(key, entry.relativePath);
  }
}

/** Recursively collects the final installer files, sorted deterministically. */
export async function collectInstallerFiles(artifactDir) {
  const found = [];
  await walk(artifactDir, "", found);
  found.sort((a, b) => comparePaths(a.relativePath, b.relativePath));
  assertNoDuplicatePaths(found);

  if (found.length === 0) {
    throw new Error(
      `no installer files found in "${artifactDir}" ` +
        `(expected at least one of: ${SUPPORTED_INSTALLER_EXTENSIONS.join(", ")})`,
    );
  }
  return found;
}

/** Streams a file through SHA-256 so multi-hundred-MB bundles stay cheap. */
export async function hashFileStream(absolutePath) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(absolutePath), hash);
  return hash.digest("hex");
}

/**
 * Writes `<hash>  <relative/posix/path>` lines for every installer found under
 * `artifactDir`. The output contains no timestamps or absolute paths, so the
 * same inputs always produce byte-identical content.
 */
export async function generateChecksumFile(artifactDir, options = {}) {
  const entries = await collectInstallerFiles(artifactDir);

  const lines = [];
  for (const entry of entries) {
    const digest = await hashFileStream(entry.absolutePath);
    lines.push(`${digest}  ${entry.relativePath}`);
  }

  const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  const outputPath = options.outPath ?? path.join(artifactDir, CHECKSUM_FILE_NAME);
  await writeFile(outputPath, content, "utf8");

  return { outputPath, entries, content };
}

function usage() {
  return (
    "usage: node scripts/generate-release-checksums.mjs <artifact-dir> [output-file]\n" +
    `  writes a deterministic ${CHECKSUM_FILE_NAME} covering ` +
    `${SUPPORTED_INSTALLER_EXTENSIONS.join(", ")} files\n`
  );
}

export async function main(argv = process.argv.slice(2)) {
  const args = argv.filter((arg) => arg !== "--");

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    process.stdout.write(usage());
    return args.length === 0 ? 1 : 0;
  }

  const artifactDir = path.resolve(args[0]);
  const outPath = args[1] === undefined ? undefined : path.resolve(args[1]);
  const { outputPath, entries, content } = await generateChecksumFile(artifactDir, { outPath });

  // Relative paths only: never print an absolute build path into a CI log.
  process.stdout.write(content);
  process.stdout.write(`wrote ${outputPath} (${entries.length} installers)\n`);
  return 0;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`generate-release-checksums: ${error.message}\n`);
      process.exitCode = 1;
    });
}

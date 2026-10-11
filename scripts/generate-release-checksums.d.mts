// Hand-written types for scripts/generate-release-checksums.mjs, which is plain
// Node ESM so it can run unbuilt in CI on Windows, macOS, and Linux. Keep this in
// sync with the exported surface of that file.

export declare const SUPPORTED_INSTALLER_EXTENSIONS: readonly string[];
export declare const CHECKSUM_FILE_NAME: string;

export interface InstallerEntry {
  /** Path relative to the artifact directory, always `/`-separated. */
  readonly relativePath: string;
  readonly absolutePath: string;
}

export declare function assertNoDuplicatePaths(entries: readonly InstallerEntry[]): void;
export declare function collectInstallerFiles(artifactDir: string): Promise<InstallerEntry[]>;
export declare function hashFileStream(absolutePath: string): Promise<string>;
export declare function generateChecksumFile(
  artifactDir: string,
  options?: { outPath?: string },
): Promise<{ outputPath: string; entries: InstallerEntry[]; content: string }>;
export declare function main(argv?: string[]): Promise<number>;

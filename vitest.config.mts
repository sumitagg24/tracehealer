import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    // The shared suite intentionally covers lib/* and app/* tests. It excludes
    // taste-litter worktrees, .next artifacts, fixtures, and build output.
    include: ["**/*.test.ts"],
    exclude: [
      "node_modules/**",
      ".git/**",
      ".next/**",
      "fixtures/**",
      "dist/**",
      "coverage/**",
      "apps/**",
    ],
    roots: [root],
    coverage: {
      reporter: ["text", "json", "html"],
    },
  },
  resolve: {
    alias: {
      "@": new URL("./", import.meta.url).pathname,
    },
  },
});

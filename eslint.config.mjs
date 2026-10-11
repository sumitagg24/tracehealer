import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // Build output and generated artifacts are never linted. Without these, a
  // local `tauri build` leaves codegen under src-tauri/target/ and `eslint .`
  // fails on files no one wrote.
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "coverage/**",
    "node_modules/**",
    "apps/desktop/src-tauri/target/**",
    "apps/desktop/src-tauri/gen/**",
    "playwright-report/**",
    "test-results/**",
    ".tracehealer-data/**",
    ".tracehealer-e2e-local/**",
    ".tracehealer-e2e-session/**",
  ]),
]);

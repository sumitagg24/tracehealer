import { defineConfig } from "@playwright/test";

/**
 * Browser E2E suite.
 *
 * Two servers are started from the same production build, both bound to
 * loopback only:
 *  - local-auth server (port 3188): the zero-secret development mode used by
 *    the demo control center. It runs with NODE_ENV=production, so it needs the
 *    documented TRACEHEALER_LOCAL_AUTH_ACK=true acknowledgement — acceptable
 *    here because the listener is loopback-only and the data root is a scratch
 *    directory.
 *  - session server (port 3189): production-style `session` auth with the
 *    durable sqlite adapter, which is the mode that actually enforces tenant
 *    isolation, so authorization is exercised for real instead of mocked.
 *
 * Run with: npm run test:e2e   (builds first, then runs Playwright)
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3188",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npx next start --hostname 127.0.0.1 --port 3188",
      url: "http://127.0.0.1:3188/api/health",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        TRACEHEALER_DATA_DIR: ".tracehealer-e2e-local",
        TRACEHEALER_AUTH_MODE: "local",
        TRACEHEALER_LOCAL_AUTH_ACK: "true",
      },
    },
    {
      command: "npx next start --hostname 127.0.0.1 --port 3189",
      url: "http://127.0.0.1:3189/api/health",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        TRACEHEALER_DATA_DIR: ".tracehealer-e2e-session",
        TRACEHEALER_STORE: "sqlite",
        TRACEHEALER_DB_FILE: ".tracehealer-e2e-session/tracehealer.db",
        TRACEHEALER_AUTH_MODE: "session",
        TRACEHEALER_SESSION_SECRET: "e2e-session-secret-32-bytes-minimum!!",
      },
    },
  ],
});

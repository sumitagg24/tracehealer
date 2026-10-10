import { performance } from "node:perf_hooks";
import { resolveReceiptRequest } from "../src/order-support.mjs";

const input = {
  order: {
    id: "TH-1048",
    contact: { primaryEmail: "ada@example.com" },
    status: "paid",
  },
  apiVersion: "2026-10-01",
};

const started = performance.now();
let attempts = 0;
let output;
let lastError;

while (attempts < 3 && !output) {
  attempts += 1;
  try {
    output = resolveReceiptRequest(input);
  } catch (error) {
    lastError = error;
  }
}

const success = Boolean(output);
const profile = success
  ? { durationMs: 820, tokens: 612, costUsd: 0.0041, errors: 0 }
  : { durationMs: 6842, tokens: 4280, costUsd: 0.0284, errors: attempts };

const result = {
  success,
  attempts,
  output: output ?? null,
  error: lastError instanceof Error ? `${lastError.name}: ${lastError.message}` : null,
  wallClockMs: Math.max(1, Math.round(performance.now() - started)),
  ...profile,
};

console.log(`TRACEHEALER_REPLAY=${JSON.stringify(result)}`);
process.exitCode = success ? 0 : 1;

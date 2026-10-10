import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  isTerminal,
  InvalidRunTransitionError,
  RUN_STATES,
  statusForState,
} from "@/lib/run-state";

describe("run state machine", () => {
  it("allows the happy-path progression and rejects skips", () => {
    expect(canTransition("queued", "reproducing")).toBe(true);
    expect(canTransition("verifying", "committing")).toBe(true);
    expect(canTransition("committing", "healed")).toBe(true);
    expect(canTransition("queued", "healed")).toBe(false);
    expect(canTransition("needs-review", "healed")).toBe(false);
  });

  it("never leaves a terminal state", () => {
    for (const state of RUN_STATES) {
      if (isTerminal(state)) {
        for (const next of RUN_STATES) {
          expect(canTransition(state, next)).toBe(false);
        }
      }
    }
  });

  it("throws a typed error on an invalid transition", () => {
    expect(() => assertTransition("needs-review", "publishing")).toThrow(InvalidRunTransitionError);
    expect(() => assertTransition("queued", "reproducing")).not.toThrow();
  });

  it("maps lifecycle to persisted status", () => {
    expect(statusForState("healed")).toBe("healed");
    expect(statusForState("delivery-failed")).toBe("needs-review");
    expect(statusForState("timed-out")).toBe("needs-review");
  });
});

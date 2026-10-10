import type { RunState } from "@/lib/types";

/** Every state a run may occupy, in rough lifecycle order. */
export const RUN_STATES: RunState[] = [
  "queued",
  "reproducing",
  "diagnosing",
  "patching",
  "verifying",
  "committing",
  "publishing",
  "healed",
  "needs-review",
  "delivery-failed",
  "cancelled",
  "timed-out",
];

/**
 * Allowed transitions. Anything not listed is rejected so a run can never skip
 * verification, publish from `needs-review`, or resurrect from a terminal state.
 */
const TRANSITIONS: Record<RunState, RunState[]> = {
  queued: ["reproducing", "needs-review", "cancelled", "timed-out"],
  reproducing: ["diagnosing", "needs-review", "cancelled", "timed-out"],
  diagnosing: ["patching", "needs-review", "cancelled", "timed-out"],
  patching: ["verifying", "needs-review", "cancelled", "timed-out"],
  verifying: ["committing", "needs-review", "cancelled", "timed-out"],
  committing: ["publishing", "healed", "needs-review", "cancelled"],
  publishing: ["healed", "delivery-failed", "needs-review"],
  healed: [],
  "needs-review": [],
  // Delivery can be retried without re-running verification, so it is settled
  // but not terminal.
  "delivery-failed": ["publishing", "healed"],
  cancelled: [],
  "timed-out": [],
};

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "healed",
  "needs-review",
  "cancelled",
  "timed-out",
]);

/** States that will never progress on their own (terminal + settled). */
export const SETTLED_STATES: ReadonlySet<RunState> = new Set<RunState>([
  ...TERMINAL_STATES,
  "delivery-failed",
]);

export const ACTIVE_STATES: ReadonlySet<RunState> = new Set<RunState>(
  RUN_STATES.filter((state) => !TERMINAL_STATES.has(state) && state !== "delivery-failed"),
);

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface TransitionViolation {
  from: RunState;
  to: RunState;
}

export class InvalidRunTransitionError extends Error {
  readonly from: RunState;
  readonly to: RunState;
  constructor(from: RunState, to: RunState) {
    super(`Invalid run state transition: ${from} -> ${to}`);
    this.name = "InvalidRunTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new InvalidRunTransitionError(from, to);
}

/** Maps a settled lifecycle to the persisted HealResult status. */
export function statusForState(state: RunState): "healed" | "needs-review" {
  return state === "healed" ? "healed" : "needs-review";
}

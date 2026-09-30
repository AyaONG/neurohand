import type { FsmState, Point, Reading } from "./types";

const STABLE_FRAMES = 4;
export const STABLE_MS = 100;
export const initialFsm: FsmState = { phase: "WAIT_OPEN", reps: 0, stable: 0 };

export function step(s: FsmState, r: Reading | null): FsmState {
  if (!r || r.error) return { ...s, stable: 0 };
  const stable = (s.phase === "ARMED" ? r.closed : r.open) ? s.stable + 1 : 0;
  if (stable < STABLE_FRAMES) return { ...s, stable };
  return s.phase === "ARMED"
    ? { phase: "CONFIRMED", reps: s.reps + 1, stable: 0 }
    : { ...s, phase: "ARMED", stable: 0 };
}

export type TimedFsm = { phase: FsmState["phase"]; reps: number; stableSince: number | null };
export function initialTimedFsm(reps = 0): TimedFsm {
  return { phase: "WAIT_OPEN", reps, stableSince: null };
}

/** Called only for new observations. Missing frames require a fresh open gesture. */
export function stepTimed(s: TimedFsm, r: Reading | null, timestampMs: number): TimedFsm {
  if (!r) return initialTimedFsm(s.reps);
  if (r.error) return { ...s, stableSince: null };
  if (!(s.phase === "ARMED" ? r.closed : r.open)) return { ...s, stableSince: null };
  const stableSince = s.stableSince ?? timestampMs;
  if (timestampMs - stableSince < STABLE_MS) return { ...s, stableSince };
  return s.phase === "ARMED"
    ? { phase: "CONFIRMED", reps: s.reps + 1, stableSince: null }
    : { ...s, phase: "ARMED", stableSince: null };
}

export type HoldState = { holdMs: number; reps: number };
export type Target = Point & { r: number };
export const HOLD_TARGET_MS = 2000;

export function createTarget(w: number, h: number): Target {
  return { x: 80 + Math.random() * Math.max(0, w - 160), y: 80 + Math.random() * Math.max(0, h - 160), r: 60 };
}

export function stepHold(s: HoldState, palm: Point | null, target: Target, dtMs: number): HoldState {
  if (!palm || Math.hypot(palm.x - target.x, palm.y - target.y) >= target.r ||
      !Number.isFinite(dtMs) || dtMs < 0) return { ...s, holdMs: 0 };
  const holdMs = s.holdMs + dtMs;
  return holdMs >= HOLD_TARGET_MS ? { holdMs: 0, reps: s.reps + 1 } : { ...s, holdMs };
}

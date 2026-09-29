import { HandGeometry, resolveConfig, type Config } from "./geometry";
import { Reading, Calibration } from "./types";

export const PINCH_CLOSE = 0.28;   // < = сомкнуты
export const PINCH_OPEN  = 0.50;   // > = разомкнуты

// Finite fallback only; this does not replace a successful user calibration.
export const DEFAULT_OPEN_CURL = 1;

export const GRIP_CLOSE_RATIO = 0.5;
export const GRIP_OPEN_RATIO = 0.85;

export function readPinch(g: HandGeometry, timestampMs: number, previousWrongJoint: number | null = null, overrides: Partial<Config> = {}): Reading {
  if (!Number.isFinite(timestampMs)) return { open: false, closed: false, error: null };
  const good = g.nd(4, 8);
  const wrongTips = [12, 16, 20].filter(t => g.nd(4, t) < PINCH_CLOSE);

  if (wrongTips.length && good > PINCH_CLOSE) {
    let selected = wrongTips.reduce((best, tip) => g.nd(4, tip) < g.nd(4, best) ? tip : best);
    if (previousWrongJoint !== null && wrongTips.includes(previousWrongJoint) &&
        g.nd(4, previousWrongJoint) - g.nd(4, selected) <= resolveConfig(overrides).HYSTERESIS_DELTA_RATIO) {
      selected = previousWrongJoint;
    }
    return {
      open: false, closed: false,
      error: {
        code: "WRONG_FINGER",
        joints: [selected],
        message: "Ошибочный палец. Используйте указательный",
      },
    };
  }
  return {
    open: good > PINCH_OPEN && wrongTips.length === 0,
    closed: good < PINCH_CLOSE,
    error: null,
  };
}

/** Caller-owned state: no hidden cross-session memory. */
export type PinchTrackingState = {
  previousWrongJoint: number | null;
  lastValidTimestamp: number | null;
};

export function stepPinchTracking(
  state: PinchTrackingState,
  g: HandGeometry | null,
  timestampMs: number,
  overrides: Partial<Config> = {},
): { state: PinchTrackingState; reading: Reading | null } {
  const config = resolveConfig(overrides);
  // Ignore invalid or out-of-order clocks without corrupting tracking state.
  if (!Number.isFinite(timestampMs) ||
      (state.lastValidTimestamp !== null && timestampMs < state.lastValidTimestamp)) {
    return { state: { ...state }, reading: null };
  }
  const expired = state.lastValidTimestamp === null ||
    timestampMs - state.lastValidTimestamp > config.NULL_TIMEOUT_MS;
  const previous = expired ? null : state.previousWrongJoint;
  if (g === null) {
    return { state: { ...state, previousWrongJoint: previous }, reading: null };
  }
  const reading = readPinch(g, timestampMs, previous, config);
  return {
    state: { previousWrongJoint: reading.error?.joints[0] ?? null, lastValidTimestamp: timestampMs },
    reading,
  };
}

export function readGrip(g: HandGeometry, cal: Calibration, timestampMs: number): Reading {
  if (!Number.isFinite(timestampMs)) return { open: false, closed: false, error: null };
  const closeThr = cal.openCurl * GRIP_CLOSE_RATIO;
  const openThr  = cal.openCurl * GRIP_OPEN_RATIO;
  const tips = [8, 12, 16, 20];
  const curls = tips.map(t => g.curl(t));
  const folded = curls.map(c => c < closeThr);

  const threeFoldedPinkyNot = folded[0] && folded[1] && folded[2] && !folded[3];
  if (threeFoldedPinkyNot) {
    return {
      open: false, closed: false,
      error: { code: "PINKY_INCOMPLETE", joints: [20], message: "Дожмите мизинец" },
    };
  }
  return {
    open: curls.every(c => c > openThr),
    closed: folded.every(Boolean),
    error: null,
  };
}

/** Нормированное раскрытие 0..1 для размера шара в упражнении 2 */
export function gripOpenness(g: HandGeometry, cal: Calibration): number {
  const avg = [8, 12, 16, 20].reduce((s, t) => s + g.curl(t), 0) / 4;
  return Math.min(1, Math.max(0, (avg - cal.openCurl * GRIP_CLOSE_RATIO) / (cal.openCurl * GRIP_CLOSE_RATIO)));
}

export function calibrate(samples: HandGeometry[]): Calibration {
  if (samples.length === 0) return { openCurl: DEFAULT_OPEN_CURL };
  const vals = samples.map(g => [8, 12, 16, 20].reduce((s, t) => s + g.curl(t), 0) / 4);
  const openCurl = vals.reduce((a, b) => a + b, 0) / vals.length;
  return { openCurl: Number.isFinite(openCurl) && openCurl > 0 ? openCurl : DEFAULT_OPEN_CURL };
}

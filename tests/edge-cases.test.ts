import { describe, expect, it } from "vitest";
import { HandGeometry, DEFAULT_CONFIG, resolveConfig } from "../src/geometry";
import { calibrate, DEFAULT_OPEN_CURL, readPinch, stepPinchTracking } from "../src/validator";
import type { Landmark } from "../src/types";

function landmarks(): Landmark[] {
  const lm = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[0] = { x: 0.5, y: 0.75, z: 0 };
  return lm;
}

describe("invalid frames", () => {
  it("rejects missing points, including sparse arrays", () => {
    expect(HandGeometry.create([], 640, 480)).toBeNull();
    expect(HandGeometry.create(landmarks().slice(1), 640, 480)).toBeNull();
    expect(HandGeometry.create(new Array(21), 640, 480)).toBeNull();
  });

  it("rejects nonfinite coordinates on all axes", () => {
    for (const axis of ["x", "y", "z"] as const) {
      for (const value of [NaN, Infinity, -Infinity]) {
        const lm = landmarks();
        lm[8][axis] = value;
        expect(HandGeometry.create(lm, 640, 480)).toBeNull();
      }
    }
  });

  it("rejects invalid dimensions and pixel overflow", () => {
    for (const size of [0, -1, NaN, Infinity]) {
      expect(HandGeometry.create(landmarks(), size, 480)).toBeNull();
      expect(HandGeometry.create(landmarks(), 640, size)).toBeNull();
    }
    const lm = landmarks();
    lm[8].x = Number.MAX_VALUE;
    expect(HandGeometry.create(lm, 640, 480)).toBeNull();
  });

  it("uses normalized pixel geometry, configurable thresholds and the 0.08 boundary", () => {
    expect(DEFAULT_CONFIG).toEqual({ MIN_HAND_SIZE_NORM: 0.08, HYSTERESIS_DELTA_RATIO: 0.05, NULL_TIMEOUT_MS: 100 });
    expect(HandGeometry.create(landmarks(), 640, 480, { MIN_HAND_SIZE_NORM: 0.26 })).toBeNull();
    expect(HandGeometry.create(landmarks(), 640, 480, { MIN_HAND_SIZE_NORM: 0.25 })).not.toBeNull();
    expect(resolveConfig({ MIN_HAND_SIZE_NORM: NaN, HYSTERESIS_DELTA_RATIO: -1, NULL_TIMEOUT_MS: 0 })).toEqual(DEFAULT_CONFIG);
    for (const [w, h] of [[640, 480], [1280, 720], [2560, 1440], [720, 1280]]) {
      for (const ratio of [0, 0.001, 0.0799, 0.08, 0.081]) {
        const lm = landmarks();
        lm[0].y = 0;
        lm[9].y = ratio * Math.min(w, h) / h;
        const g = HandGeometry.create(lm, w, h);
        if (ratio < 0.08) expect(g).toBeNull();
        else expect(g?.handSizeNorm).toBeCloseTo(ratio);
      }
      const lm = landmarks();
      lm[0] = { x: 0.2, y: 0.2, z: 0 };
      lm[9] = { x: 0.3, y: 0.35, z: 0 };
      const g = HandGeometry.create(lm, w, h)!;
      expect(g.handSize).toBeCloseTo(Math.hypot(0.1 * w, 0.15 * h));
      expect(g.handSizeNorm).toBeCloseTo(Math.hypot(0.1 * w, 0.15 * h) / Math.min(w, h));
    }
  });
});

describe("wrong finger focus", () => {
  function frame(middle: number, ring: number): HandGeometry {
    const lm = landmarks(); // palm size = 120 px
    lm[4] = { x: 0.1, y: 0.5, z: 0 };
    lm[12] = { x: 0.1 + middle * 120 / 640, y: 0.5, z: 0 };
    lm[16] = { x: 0.1 + ring * 120 / 640, y: 0.5, z: 0 };
    return HandGeometry.create(lm, 640, 480)!;
  }

  it("initially chooses the nearest wrong finger", () => {
    expect(readPinch(frame(0.2, 0.1), 1000).error?.joints).toEqual([16]);
  });

  it("keeps focus during jitter, then switches on a clear advantage", () => {
    expect(readPinch(frame(0.17, 0.15), 1000, 12, { HYSTERESIS_DELTA_RATIO: 0 }).error?.joints).toEqual([16]);
    expect(readPinch(frame(0.22, 0.12), 1000, 12, { HYSTERESIS_DELTA_RATIO: 0.2 }).error?.joints).toEqual([12]);
    let tracked = stepPinchTracking({ previousWrongJoint: null, lastValidTimestamp: null }, frame(0.15, 0.17), 1000);
    const original = tracked.state;
    // Both 30 FPS and 60 FPS schedules retain focus through exactly 100 ms.
    for (const times of [[1033, 1066, 1100], [1016, 1032, 1048, 1064, 1080, 1096, 1100]]) {
      for (const timestamp of times) {
        tracked = stepPinchTracking(tracked.state, null, timestamp);
        expect(tracked.reading).toBeNull();
        expect(tracked.state).toEqual({ previousWrongJoint: 12, lastValidTimestamp: 1000 });
      }
    }
    tracked = stepPinchTracking(tracked.state, frame(0.17, 0.15), 1100);
    expect(tracked.state).toEqual({ previousWrongJoint: 12, lastValidTimestamp: 1100 });
    tracked = stepPinchTracking(tracked.state, null, 1201);
    expect(tracked.state.previousWrongJoint).toBeNull();
    tracked = stepPinchTracking(tracked.state, frame(0.17, 0.15), 1210);
    expect(tracked.state).toEqual({ previousWrongJoint: 16, lastValidTimestamp: 1210 });
    expect(original).toEqual({ previousWrongJoint: 12, lastValidTimestamp: 1000 });
    expect(stepPinchTracking(original, null, 1011, { NULL_TIMEOUT_MS: 10 }).state.previousWrongJoint).toBeNull();
    expect(stepPinchTracking(original, null, 1101, { NULL_TIMEOUT_MS: 200 }).state.previousWrongJoint).toBe(12);
    expect(stepPinchTracking(original, frame(0.17, 0.15), 1101).state.previousWrongJoint).toBe(16);
    for (const timestamp of [NaN, Infinity, 999]) {
      expect(stepPinchTracking(original, null, timestamp).state).toEqual(original);
    }
    let previous: number | null = null;
    for (const [middle, ring, expected] of [
      [0.15, 0.17, 12], [0.17, 0.15, 12], [0.15, 0.17, 12], [0.22, 0.12, 16],
    ]) {
      const reading = readPinch(frame(middle, ring), 1000, previous);
      expect(reading.error?.joints).toEqual([expected]);
      previous = reading.error?.joints[0] ?? null;
    }
  });

  it("releases a previous finger that leaves the pinch threshold", () => {
    expect(readPinch(frame(0.29, 0.26), 1000, 12).error?.joints).toEqual([16]);
  });

  it("keeps the correct pinch priority even with previous error focus", () => {
    const lm = landmarks();
    lm[8] = { ...lm[4] };
    expect(readPinch(HandGeometry.create(lm, 640, 480)!, 1000, 12)).toEqual({
      open: false, closed: true, error: null,
    });
  });
});

it("returns a finite default for empty calibration", () => {
  expect(calibrate([])).toEqual({ openCurl: DEFAULT_OPEN_CURL });
  expect(Number.isFinite(calibrate([]).openCurl)).toBe(true);
  expect(calibrate([]).openCurl).toBeGreaterThan(0);
});

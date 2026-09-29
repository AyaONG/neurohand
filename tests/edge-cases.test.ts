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

  it("rejects scales below 15 pixels and accepts the boundary", () => {
    expect(DEFAULT_CONFIG).toEqual({ MIN_HAND_SIZE_PX: 15, HYSTERESIS_DELTA_RATIO: 0.05, NULL_FRAME_TIMEOUT: 3 });
    expect(HandGeometry.create(landmarks(), 640, 480, { MIN_HAND_SIZE_PX: 121 })).toBeNull();
    expect(HandGeometry.create(landmarks(), 640, 480, { MIN_HAND_SIZE_PX: 120 })).not.toBeNull();
    expect(resolveConfig({ MIN_HAND_SIZE_PX: NaN, HYSTERESIS_DELTA_RATIO: -1, NULL_FRAME_TIMEOUT: 0 })).toEqual(DEFAULT_CONFIG);
    expect(resolveConfig({ MIN_HAND_SIZE_PX: 10 }).MIN_HAND_SIZE_PX).toBe(10);
    for (const size of [0, 0.001, 14.99, 15, 16]) {
      const lm = landmarks();
      lm[0].y = 0;
      lm[9].y = size / 480;
      const g = HandGeometry.create(lm, 640, 480);
      if (size < 15) expect(g).toBeNull();
      else expect(g?.handSize).toBeCloseTo(size);
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
    expect(readPinch(frame(0.2, 0.1)).error?.joints).toEqual([16]);
  });

  it("keeps focus during jitter, then switches on a clear advantage", () => {
    expect(readPinch(frame(0.17, 0.15), 12, { HYSTERESIS_DELTA_RATIO: 0 }).error?.joints).toEqual([16]);
    expect(readPinch(frame(0.22, 0.12), 12, { HYSTERESIS_DELTA_RATIO: 0.2 }).error?.joints).toEqual([12]);
    let tracked = stepPinchTracking({ previousWrongJoint: null, nullFrames: 0 }, frame(0.15, 0.17));
    const original = tracked.state;
    for (let count = 1; count <= 2; count++) {
      tracked = stepPinchTracking(tracked.state, null);
      expect(tracked.reading).toBeNull();
      expect(tracked.state).toEqual({ previousWrongJoint: 12, nullFrames: count });
    }
    tracked = stepPinchTracking(tracked.state, frame(0.17, 0.15));
    expect(tracked.state).toEqual({ previousWrongJoint: 12, nullFrames: 0 });
    for (let count = 1; count <= 3; count++) tracked = stepPinchTracking(tracked.state, null);
    expect(tracked.state).toEqual({ previousWrongJoint: null, nullFrames: 3 });
    tracked = stepPinchTracking(tracked.state, frame(0.17, 0.15));
    expect(tracked.state).toEqual({ previousWrongJoint: 16, nullFrames: 0 });
    expect(original).toEqual({ previousWrongJoint: 12, nullFrames: 0 });
    expect(stepPinchTracking(original, null, { NULL_FRAME_TIMEOUT: 1 }).state.previousWrongJoint).toBeNull();
    expect(stepPinchTracking({ previousWrongJoint: 12, nullFrames: 3 }, null, { NULL_FRAME_TIMEOUT: 5 }).state.previousWrongJoint).toBe(12);
    let previous: number | null = null;
    for (const [middle, ring, expected] of [
      [0.15, 0.17, 12], [0.17, 0.15, 12], [0.15, 0.17, 12], [0.22, 0.12, 16],
    ]) {
      const reading = readPinch(frame(middle, ring), previous);
      expect(reading.error?.joints).toEqual([expected]);
      previous = reading.error?.joints[0] ?? null;
    }
  });

  it("releases a previous finger that leaves the pinch threshold", () => {
    expect(readPinch(frame(0.29, 0.26), 12).error?.joints).toEqual([16]);
  });

  it("keeps the correct pinch priority even with previous error focus", () => {
    const lm = landmarks();
    lm[8] = { ...lm[4] };
    expect(readPinch(HandGeometry.create(lm, 640, 480)!, 12)).toEqual({
      open: false, closed: true, error: null,
    });
  });
});

it("returns a finite default for empty calibration", () => {
  expect(calibrate([])).toEqual({ openCurl: DEFAULT_OPEN_CURL });
  expect(Number.isFinite(calibrate([]).openCurl)).toBe(true);
  expect(calibrate([]).openCurl).toBeGreaterThan(0);
});

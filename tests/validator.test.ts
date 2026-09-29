import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HandGeometry } from "../src/geometry";
import { calibrate, gripOpenness, readGrip, readPinch } from "../src/validator";
import { initialFsm, step, stepHold } from "../src/fsm";
import type { Landmark } from "../src/types";

const fixtureUrl = (name: string) => new URL(`./fixtures/${name}.json`, import.meta.url);

// Synthetic fixtures: 21 normalized landmarks for a 640x480 frame.
// They exercise the algorithms; they are not real camera captures.
function fixture(name: string, edit?: (lm: Landmark[]) => void): HandGeometry {
  const lm: Landmark[] = JSON.parse(readFileSync(fixtureUrl(name), "utf8"));
  expect(Array.isArray(lm)).toBe(true);
  expect(lm).toHaveLength(21);
  for (const p of lm) {
    for (const axis of ["x", "y", "z"] as const) expect(Number.isFinite(p[axis])).toBe(true);
  }
  edit?.(lm);
  const g = HandGeometry.create(lm, 640, 480);
  expect(g).not.toBeNull();
  return g!;
}

describe("open-palm fixture", () => {
  it("reads an open pinch and an open calibrated grip", () => {
    const g = fixture("grip_open");
    const cal = calibrate([g]);
    expect(cal.openCurl).toBeGreaterThan(0);
    expect(readPinch(fixture("pinch_open"), 1000).open).toBe(true);
    const hold = fixture("hold_open");
    expect(hold.palmCenter().x).toBeCloseTo(272);
    expect(hold.palmCenter().y).toBeCloseTo(248);
    expect(readPinch(g, 1000)).toEqual({ open: true, closed: false, error: null });
    expect(readGrip(g, cal, 1000)).toEqual({ open: true, closed: false, error: null });
    expect(gripOpenness(g, cal)).toBeCloseTo(1);
  });
});

describe("pinch-good fixture", () => {
  it("reads a closed pinch", () => {
    const closed = readPinch(fixture("pinch_closed"), 1000);
    const open = readPinch(fixture("pinch_open"), 1000);
    expect(closed).toEqual({ open: false, closed: true, error: null });
    let state = { ...initialFsm };
    for (let rep = 1; rep <= 2; rep++) {
      for (let i = 0; i < 4; i++) state = step(state, open);
      expect(state.phase).toBe("ARMED");
      for (let i = 0; i < 4; i++) state = step(state, closed);
      expect(state.reps).toBe(rep);
      for (let i = 0; i < 100; i++) state = step(state, closed);
      expect(state.reps).toBe(rep);
    }
    expect(step({ ...initialFsm, stable: 3 }, null).stable).toBe(0);
    const target = { x: 200, y: 200, r: 60 };
    expect(stepHold({ holdMs: 1990, reps: 0 }, target, target, 10)).toEqual({ holdMs: 0, reps: 1 });
    expect(stepHold({ holdMs: 1990, reps: 0 }, { x: 500, y: 500 }, target, 10).holdMs).toBe(0);
    expect(stepHold({ holdMs: 1990, reps: 0 }, null, target, 10).holdMs).toBe(0);
  });
});

describe("pinch-wrong-middle fixture", () => {
  it("flags the middle fingertip", () => {
    const reading = readPinch(fixture("pinch_open", lm => { lm[4] = { ...lm[12] }; }), 1000);
    expect(reading).toEqual({
      open: false, closed: false,
      error: { code: "WRONG_FINGER", joints: [12], message: "Ошибочный палец. Используйте указательный" },
    });
    expect(step({ phase: "ARMED", stable: 3, reps: 2 }, reading)).toEqual({
      phase: "ARMED", stable: 0, reps: 2,
    });
  });
});

describe("fist fixture", () => {
  it("reads a closed calibrated grip", () => {
    const cal = calibrate([fixture("grip_open")]);
    const g = fixture("grip_closed");
    expect(readGrip(g, cal, 1000)).toEqual({ open: false, closed: true, error: null });
    expect(gripOpenness(g, cal)).toBe(0);
  });
});

describe("fist-pinky-out fixture", () => {
  it("flags the unfolded pinky", () => {
    const cal = calibrate([fixture("grip_open")]);
    expect(readGrip(fixture("grip_closed", lm => { lm[20] = { x: 270 / 640, y: 105 / 480, z: 0 }; }), cal, 1000)).toEqual({
      open: false, closed: false,
      error: { code: "PINKY_INCOMPLETE", joints: [20], message: "Дожмите мизинец" },
    });
  });
});

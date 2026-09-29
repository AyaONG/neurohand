import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HandGeometry } from "../src/geometry";
import { calibrate, gripOpenness, readGrip, readPinch } from "../src/validator";
import type { Landmark } from "../src/types";

const fixtureUrl = (name: string) => new URL(`./fixtures/${name}.json`, import.meta.url);
const missing = (...names: string[]) => names.some(name => !existsSync(fixtureUrl(name)));

// Dump fixtures are arrays of 21 normalized landmarks, captured at 640x480.
// Read lazily: a skipped suite must not attempt to open missing files.
function fixture(name: string): HandGeometry {
  const lm: Landmark[] = JSON.parse(readFileSync(fixtureUrl(name), "utf8"));
  expect(Array.isArray(lm)).toBe(true);
  expect(lm).toHaveLength(21);
  for (const p of lm) {
    for (const axis of ["x", "y", "z"] as const) expect(Number.isFinite(p[axis])).toBe(true);
  }
  const g = HandGeometry.create(lm, 640, 480);
  expect(g).not.toBeNull();
  return g!;
}

describe.skipIf(missing("open-palm"))("open-palm fixture", () => {
  it("reads an open pinch and an open calibrated grip", () => {
    const g = fixture("open-palm");
    const cal = calibrate([g]);
    expect(cal.openCurl).toBeGreaterThan(0);
    expect(readPinch(g)).toEqual({ open: true, closed: false, error: null });
    expect(readGrip(g, cal)).toEqual({ open: true, closed: false, error: null });
    expect(gripOpenness(g, cal)).toBeCloseTo(1);
  });
});

describe.skipIf(missing("pinch-good"))("pinch-good fixture", () => {
  it("reads a closed pinch", () => {
    expect(readPinch(fixture("pinch-good"))).toEqual({ open: false, closed: true, error: null });
  });
});

describe.skipIf(missing("pinch-wrong-middle"))("pinch-wrong-middle fixture", () => {
  it("flags the middle fingertip", () => {
    expect(readPinch(fixture("pinch-wrong-middle"))).toEqual({
      open: false, closed: false,
      error: { code: "WRONG_FINGER", joints: [12], message: "Ошибочный палец. Используйте указательный" },
    });
  });
});

describe.skipIf(missing("open-palm", "fist"))("fist fixture", () => {
  it("reads a closed calibrated grip", () => {
    const cal = calibrate([fixture("open-palm")]);
    const g = fixture("fist");
    expect(readGrip(g, cal)).toEqual({ open: false, closed: true, error: null });
    expect(gripOpenness(g, cal)).toBe(0);
  });
});

describe.skipIf(missing("open-palm", "fist-pinky-out"))("fist-pinky-out fixture", () => {
  it("flags the unfolded pinky", () => {
    const cal = calibrate([fixture("open-palm")]);
    expect(readGrip(fixture("fist-pinky-out"), cal)).toEqual({
      open: false, closed: false,
      error: { code: "PINKY_INCOMPLETE", joints: [20], message: "Дожмите мизинец" },
    });
  });
});

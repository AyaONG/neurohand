import assert from "node:assert/strict";
import test from "node:test";
import { ExerciseValidator } from "./ExerciseValidator.ts";

const threshold = 0.125;
const validator = new ExerciseValidator({ pinchThreshold: threshold });
const fingers = [
  { tip: 8, mcp: 5, name: "указательный палец" },
  { tip: 12, mcp: 9, name: "средний палец" },
  { tip: 16, mcp: 13, name: "безымянный палец" },
  { tip: 20, mcp: 17, name: "мизинец" },
];

function openHand() {
  const landmarks = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  landmarks[2] = { x: -1, y: 0.5, z: 0 };
  landmarks[4] = { x: -2, y: 1, z: 0 };
  fingers.forEach(({ tip, mcp }, index) => {
    landmarks[mcp] = { x: -0.6 + index * 0.4, y: 1, z: 0 };
    landmarks[tip] = { x: landmarks[mcp].x, y: 2, z: 0 };
  });
  return landmarks;
}

test("correct pinch succeeds and has priority over nearby wrong fingers", () => {
  const points = openHand();
  points[8] = { ...points[4], z: threshold / 2 };
  assert.equal(validator.validatePinch(points).status, "SUCCESS");
  points[12] = { ...points[4] };
  assert.equal(validator.validatePinch(points).status, "SUCCESS");
});

for (const { tip, name } of fingers.slice(1)) {
  test(`wrong pinch identifies ${tip} and names the finger`, () => {
    const points = openHand();
    points[tip] = { ...points[4], z: threshold / 2 };
    const result = validator.validatePinch(points);
    assert.equal(result.status, "ERROR_WRONG_FINGER");
    assert.equal(result.fingerIndex, tip);
    assert.ok(result.message.includes(name));
  });
}

test("no contact and equality with threshold remain IN_PROGRESS", () => {
  const points = openHand();
  assert.equal(validator.validatePinch(points).status, "IN_PROGRESS");
  points[8] = { ...points[4], z: threshold };
  points[12] = { ...points[4], z: threshold };
  assert.equal(validator.validatePinch(points).status, "IN_PROGRESS");
});

test("nearest incorrect contact is selected", () => {
  const points = openHand();
  points[12] = { ...points[4], z: 0.1 };
  points[16] = { ...points[4], z: 0.02 };
  points[20] = { ...points[4], z: 0.08 };
  assert.equal(validator.validatePinch(points).fingerIndex, 16);
});

test("pinch respects aspectRatio and configurable threshold", () => {
  const points = openHand();
  points[8] = { ...points[4], y: points[4].y + 0.2 };
  assert.equal(validator.validatePinch(points).status, "IN_PROGRESS");
  assert.equal(new ExerciseValidator({ pinchThreshold: threshold, aspectRatio: 2 })
    .validatePinch(points).status, "SUCCESS");
  assert.equal(new ExerciseValidator({ pinchThreshold: 0.3 })
    .validatePinch(points).status, "SUCCESS");
});

test("fist checks all 16 combinations of four fingers and ignores thumb position", () => {
  for (let mask = 0; mask < 16; mask++) {
    const points = openHand();
    const extended = fingers.filter((finger, index) => {
      const isExtended = Boolean(mask & (1 << index));
      if (!isExtended) points[finger.tip] = { x: 0, y: 0.5, z: 0.2 };
      return isExtended;
    });
    const result = validator.validateFist(points);
    assert.equal(result.status, mask === 0 ? "SUCCESS" : "ERROR_INCOMPLETE_FIST");
    if (mask !== 0) {
      assert.deepEqual(result.extendedFingers, extended.map(({ tip }) => tip));
      for (const { name } of extended) assert.ok(result.message.includes(name));
    }
    if (mask === 8) assert.equal(result.message, "Дожмите мизинец");
    points[4] = { ...points[17] };
    assert.deepEqual(validator.validateFist(points), result);
  }
});

test("invalid inputs throw and validation does not mutate landmarks", () => {
  for (const pinchThreshold of [0, -1, NaN, Infinity]) {
    assert.throws(() => new ExerciseValidator({ pinchThreshold }), RangeError);
  }
  assert.throws(() => validator.validatePinch([]), RangeError);
  assert.throws(() => validator.validateFist([]), RangeError);
  const points = openHand();
  const before = structuredClone(points);
  validator.validatePinch(points);
  validator.validateFist(points);
  assert.deepEqual(points, before);
  points[8].z = NaN;
  assert.throws(() => validator.validatePinch(points), TypeError);
});

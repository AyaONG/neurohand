import { describe, expect, it } from "vitest";
import { sceneModel, mirroredPinchPoint, type SceneInput } from "../src/scenes";
import { guidedTarget } from "../src/program";
import { HandGeometry } from "../src/geometry";
import { readFileSync } from "node:fs";

const base: SceneInput = {
  exercise: "pinch", completed: 0, timestampMs: 1000, reducedMotion: false,
  pinchPoint: { x: 320, y: 240 }, palm: null, openPalm: true, openness: null,
  targets: [], holdProgress: 0, flight: null,
};

describe("scene presentation", () => {
  it("shows only confirmed collection slots, independent of a moving pinch point", () => {
    for (const completed of [0, 1, 3, 5]) {
      for (const pinchPoint of [null, { x: 30, y: 40 }, { x: 300, y: 200 }]) {
        expect(sceneModel(640, 480, { ...base, completed, pinchPoint }).slots.filter(s => s.filled)).toHaveLength(completed);
      }
    }
  });

  it("ends a flight using its original event time and respects reduced motion", () => {
    const input = { ...base, completed: 1, flight: { from: { x: 300, y: 240 }, at: 1000, action: 1 } };
    expect(sceneModel(640, 480, input).flying).toEqual(input.flight.from);
    expect(sceneModel(640, 480, { ...input, timestampMs: 1250 }).flying).not.toEqual(input.flight.from);
    expect(sceneModel(640, 480, { ...input, timestampMs: 1500 }).flying).toBeNull();
    expect(sceneModel(640, 480, { ...input, timestampMs: 6000 }).flying).toBeNull();
    const reduced = sceneModel(640, 480, { ...input, reducedMotion: true });
    expect(reduced.flying).toBeNull();
    expect(reduced.slots[0].filled).toBe(true);
  });

  it("clamps the soft ball and fills segments only from confirmed repetitions", () => {
    const closed = sceneModel(640, 480, { ...base, exercise: "grip", openness: 0 });
    const open = sceneModel(640, 480, { ...base, exercise: "grip", openness: 1 });
    expect(closed.ball!.r).toBeLessThan(open.ball!.r);
    expect(sceneModel(640, 480, { ...base, exercise: "grip", openness: -2 }).ball!.r).toBe(closed.ball!.r);
    expect(sceneModel(640, 480, { ...base, exercise: "grip", openness: 3 }).ball!.r).toBe(open.ball!.r);
    expect(sceneModel(640, 480, { ...base, exercise: "grip", completed: 2, openness: 0.3 }).slots.filter(s => s.filled)).toHaveLength(2);
    expect(sceneModel(640, 480, { ...base, exercise: "grip", openness: null }).ball!.tracked).toBe(false);
  });

  it.each([[1280, 720], [640, 480], [720, 1280]])("uses reachable distinct target coordinates at %ix%i", (w, h) => {
    const targets = [0, 1, 2].map(i => guidedTarget(w, h, i));
    for (const target of targets) {
      expect(target.x - target.r).toBeGreaterThan(0);
      expect(target.x + target.r).toBeLessThan(w);
      expect(target.y - target.r).toBeGreaterThan(0);
      expect(target.y + target.r).toBeLessThan(h);
    }
    const model = sceneModel(w, h, { ...base, exercise: "hold", completed: 1, targets, holdProgress: 0.5, palm: { x: 20, y: 20 } });
    expect(model.targets.map(t => [t.completed, t.active, t.progress])).toEqual([[true, false, 1], [false, true, 0.5], [false, false, 0]]);
    expect(model.targets[1].x).toBe(targets[1].x);
    expect(model.arrow).not.toBeNull();
    expect(sceneModel(w, h, { ...base, exercise: "hold", targets, palm: targets[0] }).arrow).toBeNull();
    expect(sceneModel(w, h, { ...base, exercise: "hold", targets, palm: null }).pointer).toBeNull();
  });

  it("places the pinch anchor in the same mirrored physical-pixel coordinates as the skeleton", () => {
    const lm = JSON.parse(readFileSync(new URL("./fixtures/pinch_open.json", import.meta.url), "utf8"));
    for (const [w, h] of [[640, 480], [1280, 720]]) {
      const g = HandGeometry.create(lm, w, h)!;
      expect(mirroredPinchPoint(g.pts, w)).toEqual({
        x: w - (lm[4].x + lm[8].x) * w / 2,
        y: (lm[4].y + lm[8].y) * h / 2,
      });
    }
  });
});

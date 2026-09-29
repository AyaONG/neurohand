import { describe, expect, it } from "vitest";
import { HandGeometry } from "../src/geometry";
import type { Point } from "../src/types";

// Synthetic open hand in pixels, wrist below the extended fingers.
const pixels: Point[] = [
  [200, 300], [170, 270], [145, 240], [120, 215], [95, 195],
  [160, 205], [155, 160], [150, 125], [145, 90],
  [200, 200], [200, 150], [200, 110], [200, 70],
  [235, 210], [240, 165], [245, 130], [250, 100],
  [265, 225], [275, 195], [285, 170], [295, 145],
].map(([x, y]) => ({ x, y }));

function hand(w: number, h: number, pts = pixels): HandGeometry {
  return new HandGeometry(pts.map(p => ({ x: p.x / w, y: p.y / h, z: 0 })), w, h);
}

describe("HandGeometry", () => {
  it("uses pixel distances and the wrist-to-middle-MCP scale", () => {
    const g = hand(640, 480);
    expect(g.handSize).toBeCloseTo(100, 10);
    expect(g.dist(0, 12)).toBeCloseTo(230, 10);
    expect(g.palmCenter().x).toBeCloseTo(212, 10);
    expect(g.palmCenter().y).toBeCloseTo(228, 10);
  });

  it("preserves distances, nd and curl across 640x480 and 1280x720", () => {
    const a = hand(640, 480);
    const b = hand(1280, 720);
    for (let i = 0; i < 21; i++) {
      expect(b.dist(0, i)).toBeCloseTo(a.dist(0, i), 10);
      expect(b.nd(4, i)).toBeCloseTo(a.nd(4, i), 10);
      expect(b.curl(i)).toBeCloseTo(a.curl(i), 10);
    }
  });

  it("keeps nd and curl invariant when the hand doubles in size", () => {
    const a = hand(640, 480);
    const b = hand(1280, 720, pixels.map(p => ({ x: p.x * 2, y: p.y * 2 })));
    expect(b.handSize).toBeCloseTo(2 * a.handSize, 10);
    for (const tip of [4, 8, 12, 16, 20]) {
      expect(b.nd(4, tip)).toBeCloseTo(a.nd(4, tip), 10);
      expect(b.curl(tip)).toBeCloseTo(a.curl(tip), 10);
    }
  });

  it("gives a folded finger smaller curl and recognizes folding", () => {
    const open = hand(640, 480);
    const folded = hand(640, 480, pixels.map((p, i) => i === 8 ? { x: 210, y: 235 } : p));
    expect(folded.curl(8)).toBeLessThan(open.curl(8));
    expect(folded.isFingerFolded(8, 0.55)).toBe(true);
    expect(open.isFingerFolded(8, 0.55)).toBe(false);
  });
});

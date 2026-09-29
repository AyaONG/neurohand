import { Landmark, Point } from "./types";

export class HandGeometry {
  readonly pts: Point[];      // в пикселях, БЕЗ зеркалирования
  readonly handSize: number;  // расстояние 0–9

  constructor(lm: Landmark[], w: number, h: number) {
    this.pts = lm.map(p => ({ x: p.x * w, y: p.y * h }));
    this.handSize = this.dist(0, 9);
  }

  dist(a: number, b: number): number {
    return Math.hypot(this.pts[a].x - this.pts[b].x, this.pts[a].y - this.pts[b].y);
  }

  /** Расстояние, нормированное на размер руки */
  nd(a: number, b: number): number {
    return this.dist(a, b) / this.handSize;
  }

  palmCenter(): Point {
    const ids = [0, 5, 9, 13, 17];
    return {
      x: ids.reduce((s, i) => s + this.pts[i].x, 0) / ids.length,
      y: ids.reduce((s, i) => s + this.pts[i].y, 0) / ids.length,
    };
  }

  /** Насколько кончик далеко от центра ладони (0 = прижат, ~1+ = вытянут) */
  curl(tip: number): number {
    const c = this.palmCenter();
    return Math.hypot(this.pts[tip].x - c.x, this.pts[tip].y - c.y) / this.handSize;
  }

  isFingerFolded(tip: number, threshold: number): boolean {
    return this.curl(tip) < threshold;
  }
}

import { Landmark, Point } from "./types";

export type Config = {
  MIN_HAND_SIZE_PX: number;
  HYSTERESIS_DELTA_RATIO: number;
  NULL_FRAME_TIMEOUT: number;
};

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  MIN_HAND_SIZE_PX: 15,
  HYSTERESIS_DELTA_RATIO: 0.05,
  NULL_FRAME_TIMEOUT: 3,
});

/** Invalid overrides fall back to defaults without throwing. */
export function resolveConfig(overrides: Partial<Config> = {}): Config {
  const min = overrides.MIN_HAND_SIZE_PX;
  const delta = overrides.HYSTERESIS_DELTA_RATIO;
  const timeout = overrides.NULL_FRAME_TIMEOUT;
  return {
    MIN_HAND_SIZE_PX: min !== undefined && Number.isFinite(min) && min > 0 ? min : DEFAULT_CONFIG.MIN_HAND_SIZE_PX,
    HYSTERESIS_DELTA_RATIO: delta !== undefined && Number.isFinite(delta) && delta >= 0 ? delta : DEFAULT_CONFIG.HYSTERESIS_DELTA_RATIO,
    NULL_FRAME_TIMEOUT: timeout !== undefined && Number.isInteger(timeout) && timeout > 0 ? timeout : DEFAULT_CONFIG.NULL_FRAME_TIMEOUT,
  };
}

export class HandGeometry {
  readonly pts: Point[];      // в пикселях, БЕЗ зеркалирования
  readonly handSize: number;  // расстояние 0–9

  private constructor(pts: Point[], handSize: number) {
    this.pts = pts;
    this.handSize = handSize;
  }

  /** Reject invalid frames without exceptions in the tracking loop. */
  static create(lm: Landmark[], w: number, h: number, overrides: Partial<Config> = {}): HandGeometry | null {
    if (!Array.isArray(lm) || lm.length !== 21 ||
        !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    const pts: Point[] = [];
    for (const p of lm) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
      const x = p.x * w;
      const y = p.y * h;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      pts.push({ x, y });
    }
    const handSize = Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y);
    if (!Number.isFinite(handSize) || handSize < resolveConfig(overrides).MIN_HAND_SIZE_PX) return null;
    return new HandGeometry(pts, handSize);
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

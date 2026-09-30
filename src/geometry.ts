import { Landmark, Point } from "./types";

export type Config = {
  MIN_HAND_SIZE_NORM: number;
  HYSTERESIS_DELTA_RATIO: number;
  NULL_TIMEOUT_MS: number;
};

export const DEFAULT_CONFIG: Readonly<Config> = Object.freeze({
  MIN_HAND_SIZE_NORM: 0.08,
  HYSTERESIS_DELTA_RATIO: 0.05,
  NULL_TIMEOUT_MS: 100,
});

/** Invalid overrides fall back to defaults without throwing. */
export function resolveConfig(overrides: Partial<Config> = {}): Config {
  const min = overrides.MIN_HAND_SIZE_NORM;
  const delta = overrides.HYSTERESIS_DELTA_RATIO;
  const timeout = overrides.NULL_TIMEOUT_MS;
  return {
    MIN_HAND_SIZE_NORM: min !== undefined && Number.isFinite(min) && min > 0 ? min : DEFAULT_CONFIG.MIN_HAND_SIZE_NORM,
    HYSTERESIS_DELTA_RATIO: delta !== undefined && Number.isFinite(delta) && delta >= 0 ? delta : DEFAULT_CONFIG.HYSTERESIS_DELTA_RATIO,
    NULL_TIMEOUT_MS: timeout !== undefined && Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_CONFIG.NULL_TIMEOUT_MS,
  };
}

export class HandGeometry {
  readonly pts: Point[];      // в пикселях, БЕЗ зеркалирования
  readonly depths: readonly number[];
  readonly handSizeNorm: number;
  readonly handSize: number;  // расстояние 0–9

  private constructor(pts: Point[], handSize: number, handSizeNorm: number, depths: number[]) {
    this.depths = depths;
    this.pts = pts;
    this.handSize = handSize;
    this.handSizeNorm = handSizeNorm;
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
    const handSizeNorm = handSize / Math.min(w, h);
    // Permit only floating-point roundoff at the exact boundary (e.g. portrait frames).
    const minimum = resolveConfig(overrides).MIN_HAND_SIZE_NORM;
    if (!Number.isFinite(handSizeNorm) || handSizeNorm <= 0 ||
        handSizeNorm + Number.EPSILON * minimum < minimum) return null;
    return new HandGeometry(pts, handSize, handSizeNorm, lm.map(p => p.z * w / handSize));
  }

  depthDifference(a: number, b: number): number { return Math.abs(this.depths[a] - this.depths[b]); }

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

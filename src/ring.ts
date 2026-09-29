import type { Attempt } from './attempts';
import type { Session } from './session';
import type { Point } from './types';
export const RING_TIPS = [8, 12, 16, 20, 4] as const;
export type RingTip = typeof RING_TIPS[number];
export const RING_NAMES: Record<RingTip, string> = { 8: 'указательный', 12: 'средний', 16: 'безымянный', 20: 'мизинец', 4: 'большой' };
export const RING_RULES = Object.freeze({ version: 'ring-v1', marks: 12, direction: 'clockwise' as const,
  radiusRatio: 0.3, corridorRatio: 0.18, readyMs: 400, intentMs: 100, intentAngle: 0.10,
  startTolerance: 0.08, maxGapMs: 250, maxStepAngle: 0.35, maxSpeed: 4, maxActiveMs: 15000 });
export type RingSettings = { tip: RingTip; rulesVersion: string; direction: 'clockwise'; marks: 12;
  radiusRatio: number; corridorRatio: number; maxActiveMs: number };
export function ringSettings(tip: RingTip = 8): RingSettings {
  if (!RING_TIPS.includes(tip)) throw new Error('Unknown fingertip');
  return { tip, rulesVersion: RING_RULES.version, direction: 'clockwise', marks: 12,
    radiusRatio: RING_RULES.radiusRatio, corridorRatio: RING_RULES.corridorRatio, maxActiveMs: RING_RULES.maxActiveMs };
}
export function parseRingSettings(v: any): RingSettings | null {
  if (!v || !RING_TIPS.includes(v.tip)) return null;
  const settings = ringSettings(v.tip);
  return Object.entries(settings).every(([k, value]) => v[k] === value) ? settings : null;
}
/** Canvas backing coordinates. Video and canvas share the source aspect ratio and contain fit:
 * no crop/letterbox inside the viewport; CSS resizes both by the same uniform scale. */
export function screenPoint(p: Point, width: number, height: number): Point {
  return { x: width - p.x * width, y: p.y * height };
}
export function ringLayout(width: number, height: number) {
  return { x: width / 2, y: height / 2, r: Math.min(width, height) * RING_RULES.radiusRatio };
}
export const markAngle = (index: number) => (index + 0.5) * Math.PI * 2 / 12;
export const ringPoint = (r: ReturnType<typeof ringLayout>, angle: number): Point => ({ x: r.x + r.r * Math.sin(angle), y: r.y - r.r * Math.cos(angle) });
export const finishesRing = (a: Attempt) => ['completed', 'partial', 'incomplete'].includes(a.outcome!) && !['pause', 'results'].includes(a.endReason!);
export function settleRing(s: Session): Session {
  if (s.mode !== 'ring') return s;
  const records = s.attempts!.records, all = [...records, ...(s.attempts!.active ? [s.attempts!.active] : [])];
  const terminal = records.find(finishesRing);
  return { ...s, ...(terminal ? { status: 'completed' as const, endedAt: terminal.endedAt, paused: true } : {}),
    exercises: { ...s.exercises, ring: { reps: records.filter(a => a.outcome === 'completed').length, target: 1,
      started: all.length > 0, activeMs: all.reduce((n, a) => n + a.activeMs, 0), promptEpisodes: {}, bestHoldMs: null } } };
}

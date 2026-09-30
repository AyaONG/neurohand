import { goalLink } from './goals';
import { closeActive, finishAttempt, observeAttempt, startAttempt, type AttemptMetrics, type AttemptEndReason } from './attempts';
import { markAngle, ringLayout, RING_RULES as R, settleRing } from './ring';
import type { Program, ProgramFrame } from './program';
import type { Point } from './types';
export type RingState = { previous: Point | null; angle: number; originAngle: number; travel: number; readySince: number | null;
  ready: boolean; intentSince: number | null; width: number; height: number; message: string };
export const emptyRingState = (): RingState => ({ previous: null, angle: 0, originAngle: 0, travel: 0, readySince: null,
  ready: false, intentSince: null, width: 0, height: 0, message: '' });
export function restartRing(p: Program, reason: 'resize' | 'pause' = 'pause'): Program {
  const session = settleRing({ ...p.session, paused: false, attempts: closeActive(p.session.attempts, reason) });
  return { ...p, session, phase: session.status === 'completed' ? 'summary' : 'preparing', pauseReason: null,
    ringState: emptyRingState(), lastTimestamp: null, lastValidTimestamp: null, missingSince: null, reading: null, success: null };
}
function end(p: Program, reason: AttemptEndReason, wall: string): Program {
  const a = p.session.attempts?.active;
  const attempts = reason === 'confirmed' && a ? finishAttempt(p.session.attempts!, a.attemptId, 'completed', reason, wall)
    : closeActive(p.session.attempts, reason, wall);
  const session = settleRing({ ...p.session, attempts });
  return { ...p, session, ringState: emptyRingState(), phase: session.status === 'completed' ? 'summary' : 'preparing' };
}
export const finishRingAttempt = (p: Program, wall: string) => end(p, 'manual', wall);
export function stepRingProgram(old: Program, f: ProgramFrame): Program {
  const now = f.timestampMs;
  if (old.session.status !== 'in_progress' || old.phase === 'intro' || old.phase === 'paused' || !Number.isFinite(now) ||
      (old.lastTimestamp !== null && now <= old.lastTimestamp)) return old;
  let p: Program = { ...old, lastTimestamp: now };
  let s = { ...old.ringState };
  const input = f.ring;
  if (!input || !input.point || !f.fullHand || !f.geometry) {
    p = end(p, 'tracking', f.wallTime);
    return { ...p, lastValidTimestamp: null, missingSince: old.missingSince ?? now };
  }
  const { width, height, point } = input;
  if (s.width && (width !== s.width || height !== s.height)) p = end(p, 'resize', f.wallTime);
  else if (old.lastValidTimestamp !== null && now - old.lastValidTimestamp > R.maxGapMs) p = end(p, 'tracking', f.wallTime);
  if (p.ringState !== old.ringState) s = { ...p.ringState };
  p = { ...p, lastValidTimestamp: now, missingSince: null };
  s.width = width; s.height = height;
  const ring = ringLayout(width, height), q = { x: (point.x - ring.x) / ring.r, y: (point.y - ring.y) / ring.r };
  const radius = Math.hypot(q.x, q.y), angle = Math.atan2(q.x, -q.y);
  const inCorridor = Number.isFinite(radius) && Math.abs(radius - 1) <= R.corridorRatio;
  const atStart = inCorridor && Math.abs(angle) <= R.startTolerance;
  const dt = old.lastValidTimestamp === null ? 0 : now - old.lastValidTimestamp;
  const delta = Math.atan2(Math.sin(angle - s.angle), Math.cos(angle - s.angle));
  const distance = s.previous ? Math.hypot(q.x - s.previous.x, q.y - s.previous.y) : 0;
  // Closest point on the chord must remain inside the corridor too (no center shortcut).
  const vx = s.previous ? q.x - s.previous.x : 0, vy = s.previous ? q.y - s.previous.y : 0;
  const t = s.previous && distance ? Math.max(0, Math.min(1, -(s.previous.x * vx + s.previous.y * vy) / (distance * distance))) : 0;
  const chordRadius = s.previous ? Math.hypot(s.previous.x + t * vx, s.previous.y + t * vy) : radius;
  const jump = !!s.previous && (Math.abs(delta) > R.maxStepAngle || distance > R.maxSpeed * dt / 1000 + 0.025);
  if (!inCorridor || jump || chordRadius < 1 - R.corridorRatio) {
    p = end(p, jump ? 'jump' : 'off_path', f.wallTime);
    return { ...p, ringState: { ...emptyRingState(), message: jump ? 'Скачок: верни кончик на старт' : 'Веди кончик внутри коридора. Вернись на старт' } };
  }
  if (!s.ready) {
    s.readySince = atStart ? s.readySince ?? now : null;
    s.ready = s.readySince !== null && now - s.readySince >= R.readyMs;
    s.angle = angle; s.originAngle = angle; s.previous = q; s.travel = 0;
    return { ...p, ringState: s, phase: s.ready ? 'exercise' : 'preparing' };
  }
  // Signed net angle, never a sum of positive jitter. Small reversals cannot earn marks twice.
  s.travel += delta; s.angle = angle; s.previous = q;
  if (s.travel < -R.startTolerance) {
    p = end(p, 'off_path', f.wallTime);
    return { ...p, ringState: { ...emptyRingState(), message: 'Двигайся по часовой стрелке от старта' } };
  }
  let log = p.session.attempts!;
  if (!log.active) {
    s.intentSince = s.travel >= R.intentAngle ? s.intentSince ?? now : null;
    if (s.intentSince === null || now - s.intentSince < R.intentMs) return { ...p, ringState: s };
    log = startAttempt(log, { attemptId: crypto.randomUUID(), ...goalLink(p.session), exerciseId: 'ring', protocolVersion: p.session.protocolId,
      recognizerVersion: p.session.recognitionVersion, hand: p.session.hand, rulesVersion: R.version,
      settings: { target: 1, holdTargetMs: p.session.settings.holdTargetMs, targetRadiusRatio: p.session.settings.targetRadiusRatio,
        maxActiveMs: R.maxActiveMs, ring: { ...p.session.ring! } },
      startedAt: new Date(Date.parse(f.wallTime) - (now - s.intentSince!)).toISOString(), lastObservedAt: f.wallTime, endedAt: null, outcome: null, endReason: null,
      activeMs: now - s.intentSince!, validTrackingMs: now - s.intentSince!, interruptions: { count: 0, durationMs: 0 },
      metrics: { kind: 'ring', marks: 0, returned: false, pathLength: 0, progress: 0 } });
  }
  const a = log.active!, before = a.metrics;
  if (before.kind !== 'ring') return p;
  let marks = before.marks;
  while (marks < 12 && s.travel + s.originAngle >= markAngle(marks)) marks++;
  const returned = marks === 12 && s.travel + s.originAngle >= 2 * Math.PI - R.startTolerance && atStart;
  const metrics: AttemptMetrics = { kind: 'ring', marks, returned,
    pathLength: before.pathLength + (old.session.attempts?.active ? distance : 0), progress: marks / 12 };
  log = observeAttempt(log, a.attemptId, old.session.attempts?.active ? dt : 0, f.wallTime, metrics);
  p = { ...p, ringState: s, session: settleRing({ ...p.session, attempts: log }), phase: 'exercise' };
  if (returned) return end(p, 'confirmed', f.wallTime);
  if (log.active!.activeMs >= R.maxActiveMs) return end(p, 'timeout', f.wallTime);
  return p;
}
export function ringInstruction(p: Program): string {
  if (p.phase === 'paused') return 'Тренировка на паузе. Продолжение — со старта кольца';
  if (p.ringState.message) return p.ringState.message;
  if (!p.ringState.ready) return 'Удержи кончик на старте, затем двигайся по часовой стрелке';
  return 'Обведи кольцо по отметкам 1–12 и вернись на старт';
}

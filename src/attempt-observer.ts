import { HOLD_RECOGNITION, HOLD_RULES_VERSION } from './hold-stability';
import { goalLink } from './goals';
import { ATTEMPT_RULES as R, emptyAttempts, startAttempt, observeAttempt, finishAttempt, observedOutcome, type AttemptMetrics } from './attempts';
import type { Session } from './session';

/** Transient readiness/filter state. Never serialized, and never shared across attempts. */
export type AttemptObserver = {
  baseline: number | null;
  candidateSince: number | null; candidateWall: string | null; returnSince: number | null;
  samples: { at: number; value: number }[];
  waitingOpen: boolean;
};
export const emptyObserver = (): AttemptObserver => ({ baseline: null,
  candidateSince: null, candidateWall: null, returnSince: null, samples: [], waitingOpen: true });
export type AttemptObservation = {
  now: number; wallTime: string; dt: number; ready: boolean; open: boolean; error: boolean;
  distance: number; successDistance: number;
  holdMs: number; confirmed: boolean;
};
const clamp = (n: number) => Math.min(1, Math.max(0, n));

export function observeMovement(session: Session, previous: AttemptObserver, f: AttemptObservation): { session: Session; observer: AttemptObserver } {
  let s = { ...previous, samples: [...previous.samples] };
  const hold = session.currentExercise === 'hold';
  let log = session.attempts;
  if (!log?.active) {
    if (s.waitingOpen) {
      // After timeout require an observed return, not another movement farther along the same excursion.
      const notReturned = s.baseline !== null && (hold
        ? s.baseline - f.distance > R.holdMovementRatio / 2
        : (s.baseline - f.distance) / (s.baseline - f.successDistance) > R.intentRatio / 2);
      const needsOutside = hold && session.recognitionVersion === HOLD_RECOGNITION && f.distance < 1;
      if (!f.open || notReturned || needsOutside) return { session, observer: { ...s, samples: [] } };
      s.samples.push({ at: f.now, value: f.distance });
      while (s.samples.length > 1 && s.samples[1].at <= f.now - R.stableMs) s.samples.shift();
      if ((!hold && !f.ready) || f.now - s.samples[0].at < R.stableMs) return { session, observer: s };
      const values = s.samples.map(sample => sample.value).sort((a, b) => a - b);
      s = { ...emptyObserver(), waitingOpen: false, baseline: values[Math.floor(values.length / 2)] };
    }
    if (!hold && (s.baseline === null || s.baseline - f.successDistance < R.minRange)) return { session, observer: emptyObserver() };
  }
  // A conservative time window: one close outlier cannot improve the metric.
  s.samples.push({ at: f.now, value: f.distance });
  while (s.samples.length > 1 && s.samples[1].at <= f.now - R.stableMs) s.samples.shift();
  const stable = f.now - s.samples[0].at >= R.stableMs;
  const distance = Math.max(...s.samples.map(p => p.value));
  const progress = hold ? clamp(f.holdMs / session.settings.holdTargetMs)
    : clamp(((s.baseline ?? f.distance) - distance) / ((s.baseline ?? f.distance) - f.successDistance));
  const moved = hold
    ? s.baseline! - f.distance >= R.holdMovementRatio
    : (s.baseline! - f.distance) / (s.baseline! - f.successDistance) >= R.intentRatio;
  if (!log?.active) {
    // Even a wrong gesture may be an intentional attempt, but never a success.
    if (!moved || (hold && !f.open)) {
      return { session, observer: { ...s, candidateSince: null, candidateWall: null } };
    }
    s.candidateSince ??= f.now;
    s.candidateWall ??= f.wallTime;
    if (f.now - s.candidateSince < R.stableMs) return { session, observer: s };
    const metrics: AttemptMetrics = hold
      ? { kind: 'hold', bestHoldMs: 0, targetMs: session.settings.holdTargetMs, progress: 0 }
      : { kind: 'closure', startDistance: s.baseline!, successDistance: f.successDistance, bestDistance: s.baseline!, progress: 0 };
    log = startAttempt(log ?? emptyAttempts(false), {
      attemptId: crypto.randomUUID(), ...goalLink(session, session.exercises[session.currentExercise]!.reps - Number(f.confirmed)), exerciseId: session.currentExercise,
      protocolVersion: session.protocolId, recognizerVersion: session.recognitionVersion,
      hand: session.hand, rulesVersion: hold && session.recognitionVersion === HOLD_RECOGNITION ? HOLD_RULES_VERSION : R.version,
      settings: { target: session.exercises[session.currentExercise]!.target, holdTargetMs: session.settings.holdTargetMs,
        targetRadiusRatio: session.settings.targetRadiusRatio, maxActiveMs: R.maxActiveMs },
      startedAt: s.candidateWall, lastObservedAt: s.candidateWall, endedAt: null, outcome: null, endReason: null,
      activeMs: 0, validTrackingMs: 0, interruptions: { count: 0, durationMs: 0 }, metrics,
    });
    // The intent window contained adjacent valid observations (the caller resets on gaps).
    f = { ...f, dt: f.now - s.candidateSince };
  }
  const a = log.active!;
  let metrics = a.metrics;
  if (stable && !f.error && metrics.kind !== 'skipped' && metrics.kind !== 'ring') {
    metrics = metrics.kind === 'hold'
      ? { ...metrics, bestHoldMs: Math.max(metrics.bestHoldMs, f.holdMs), progress: Math.max(metrics.progress, progress) }
      : { ...metrics, bestDistance: Math.min(metrics.bestDistance, distance), progress: Math.max(metrics.progress, progress) };
  }
  log = observeAttempt(log, a.attemptId, f.dt, f.wallTime, metrics);
  const returned = hold ? metrics.kind === 'hold' && metrics.bestHoldMs > 0 && f.holdMs === 0 && !f.confirmed
    : f.open && (s.baseline! - f.distance) / (s.baseline! - f.successDistance) <= R.intentRatio / 2;
  s.returnSince = returned ? s.returnSince ?? f.now : null;
  if (f.confirmed || (s.returnSince !== null && f.now - s.returnSince >= R.stableMs) || log.active!.activeMs >= R.maxActiveMs) {
    const reason = f.confirmed ? 'confirmed' : log.active!.activeMs >= R.maxActiveMs ? 'timeout' : 'returned';
    log = finishAttempt(log, a.attemptId, f.confirmed ? 'completed' : observedOutcome(log.active!), reason, f.wallTime);
    if (reason === 'returned' && f.open) {
      const values = s.samples.map(sample => sample.value).sort((a, b) => a - b);
      s = { ...emptyObserver(), waitingOpen: false, baseline: values[Math.floor(values.length / 2)] };
    } else s = { ...emptyObserver(), baseline: reason === 'timeout' ? s.baseline : null };
  }
  return { session: { ...session, attempts: log }, observer: s };
}

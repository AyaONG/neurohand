import type { Program, ProgramFrame } from './program';
import type { Attempt, AttemptEndReason, AttemptOutcome } from './attempts';
import { closeActive, finishAttempt, interruptAttempt, observeAttempt, observedOutcome, startAttempt } from './attempts';
import { consumesPair, currentPair, PAIR_RULES as R, PAIR_THRESHOLDS, pairTask, readOpposition, settleOpposition } from './opposition';

export type OppositionState = { baseline: number | null; openSince: number | null;
  intentSince: number | null; intentWall: string | null; closeSince: number | null; returnSince: number | null;
  samples: { at: number; distance: number }[] };
export const emptyOppositionState = (): OppositionState => ({ baseline: null, openSince: null,
  intentSince: null, intentWall: null, closeSince: null, returnSince: null, samples: [] });
const reset = (p: Program): Program => ({ ...p, oppositionState: emptyOppositionState(),
  lastTimestamp: null, lastValidTimestamp: null, missingSince: null, reading: null, success: null });

export function restartOpposition(p: Program, reason: 'pause' | 'resize'): Program {
  const session = settleOpposition({ ...p.session, paused: false, attempts: closeActive(p.session.attempts, reason) });
  return reset({ ...p, session, phase: session.status === 'completed' ? 'summary' : 'preparing', pauseReason: null });
}
function terminal(p: Program, outcome: AttemptOutcome, reason: AttemptEndReason, wallTime: string): Program {
  const active = p.session.attempts!.active;
  if (!active) return p;
  const attempts = finishAttempt(p.session.attempts!, active.attemptId, outcome, reason, wallTime);
  const session = settleOpposition({ ...p.session, attempts });
  return { ...p, session, oppositionState: emptyOppositionState(),
    phase: session.status === 'completed' ? 'summary' : session.paused ? 'paused' : 'preparing',
    success: outcome === 'completed' ? { exercise: 'opposition', reps: session.exercises.opposition!.reps, at: p.lastTimestamp ?? 0 } : null };
}
function newAttempt(p: Program, wallTime: string, skipped = false): Attempt {
  const tip = currentPair(p.session), state = p.oppositionState;
  return { attemptId: crypto.randomUUID(), exerciseId: 'opposition', protocolVersion: p.session.protocolId,
    recognizerVersion: R.recognizerVersion, hand: p.session.hand, rulesVersion: R.version,
    settings: { target: p.session.opposition!.sequence.length, holdTargetMs: p.session.settings.holdTargetMs,
      targetRadiusRatio: p.session.settings.targetRadiusRatio, maxActiveMs: R.maxActiveMs,
      pairTip: tip, sequenceIndex: p.session.opposition!.cursor, partialRatio: R.partialRatio },
    startedAt: skipped ? wallTime : state.intentWall!, lastObservedAt: wallTime, endedAt: null, outcome: null, endReason: null,
    activeMs: skipped ? 0 : p.lastTimestamp! - state.intentSince!, validTrackingMs: skipped ? 0 : p.lastTimestamp! - state.intentSince!,
    interruptions: { count: 0, durationMs: 0 },
    metrics: skipped ? { kind: 'skipped', progress: 0 } : { kind: 'closure', startDistance: state.baseline!,
      successDistance: PAIR_THRESHOLDS[tip].close, bestDistance: state.baseline!, progress: 0 } };
}

export function finishOppositionAttempt(p: Program, wallTime: string): Program {
  if (p.session.mode !== 'opposition' || p.session.status !== 'in_progress' || !p.session.attempts?.active) return p;
  return terminal(p, p.missingSince !== null ? 'unscorable' : observedOutcome(p.session.attempts.active),
    p.missingSince !== null ? 'tracking' : 'manual', wallTime);
}
export function skipOppositionPair(p: Program, wallTime: string): Program {
  if (p.session.mode !== 'opposition' || p.session.status !== 'in_progress' || p.session.attempts?.active || p.session.opposition!.awaitingRelease) return p;
  const attempt = newAttempt(p, wallTime, true);
  return terminal({ ...p, session: { ...p.session, attempts: startAttempt(p.session.attempts!, attempt) } }, 'cancelled', 'skip', wallTime);
}

export function stepOppositionProgram(previous: Program, frame: ProgramFrame): Program {
  const now = frame.timestampMs;
  if (previous.session.status !== 'in_progress' || previous.phase === 'intro' || !Number.isFinite(now) ||
      (previous.lastTimestamp !== null && now <= previous.lastTimestamp)) return previous;
  const g = frame.fullHand ? frame.geometry : null;
  const reading = g ? readOpposition(g, currentPair(previous.session)) : null;
  if (previous.phase === 'paused') {
    return previous.pauseReason === 'tracking' && reading?.open ? restartOpposition(previous, 'pause') : previous;
  }
  let p: Program = { ...previous, lastTimestamp: now, reading };
  const gap = previous.lastValidTimestamp === null ? 0 : now - previous.lastValidTimestamp;
  const contiguous = previous.lastValidTimestamp !== null && gap <= R.maxGapMs;
  if (!g || !contiguous) {
    const lostMs = previous.lastTimestamp === null ? 0 : now - previous.lastTimestamp;
    p = { ...p, oppositionState: emptyOppositionState(), success: null, session: { ...p.session,
      attempts: interruptAttempt(p.session.attempts, lostMs, previous.missingSince === null) } };
    if (g && p.session.attempts!.active) p = terminal(p, 'unscorable', 'tracking', frame.wallTime);
  }
  if (!g) {
    const missingSince = p.missingSince ?? now;
    p = { ...p, missingSince, lastValidTimestamp: null };
    if (now - missingSince < R.lostPauseMs) return p;
    p = terminal(p, 'unscorable', 'tracking', frame.wallTime);
    return { ...p, phase: 'paused', pauseReason: 'tracking', session: { ...p.session, paused: true } };
  }
  p = { ...p, lastValidTimestamp: now, missingSince: null };
  let state = { ...p.oppositionState, samples: [...p.oppositionState.samples] };
  const tip = currentPair(p.session), distance = g.nd(4, tip), close = PAIR_THRESHOLDS[tip].close;
  const sample = () => {
    state.samples.push({ at: now, distance });
    while (state.samples.length > 1 && state.samples[1].at <= now - R.filterMs) state.samples.shift();
  };
  if (p.session.opposition!.awaitingRelease) {
    state.openSince = reading!.open ? state.openSince ?? now : null;
    if (state.openSince !== null && now - state.openSince >= R.readyMs) {
      // The old target remains visible until release is actually observed, including after reload.
      return { ...p, success: null, phase: 'preparing', oppositionState: emptyOppositionState(),
        session: { ...p.session, opposition: { ...p.session.opposition!, cursor: p.session.opposition!.cursor + 1, awaitingRelease: false } } };
    }
    return { ...p, oppositionState: state };
  }
  if (state.baseline === null) {
    if (!reading!.open) return { ...p, phase: 'preparing', oppositionState: emptyOppositionState() };
    state.openSince ??= now; sample();
    if (now - state.openSince >= R.readyMs) {
      const values = state.samples.map(s => s.distance).sort((a, b) => a - b);
      const baseline = values[Math.floor(values.length / 2)];
      if (baseline - close >= R.minRange) state = { ...state, baseline, samples: [], openSince: null };
    }
    return { ...p, phase: state.baseline === null ? 'preparing' : 'exercise', oppositionState: state };
  }
  if (reading!.error) state.samples = []; else sample();
  let justStarted = false;
  if (!p.session.attempts!.active) {
    const moved = (state.baseline - distance) / (state.baseline - close) >= R.intentRatio;
    if (!moved || reading!.error) return { ...p, oppositionState: { ...state, intentSince: null, intentWall: null } };
    state.intentSince ??= now; state.intentWall ??= frame.wallTime;
    if (now - state.intentSince < R.intentMs) return { ...p, oppositionState: state };
    p = { ...p, oppositionState: state };
    p = { ...p, session: { ...p.session, attempts: startAttempt(p.session.attempts!, newAttempt(p, frame.wallTime)) } };
    justStarted = true;
  }
  const a = p.session.attempts!.active!;
  let metrics = a.metrics;
  if (metrics.kind === 'closure' && state.samples.length && now - state.samples[0].at >= R.filterMs) {
    const bestDistance = Math.min(metrics.bestDistance, Math.max(...state.samples.map(s => s.distance)));
    metrics = { ...metrics, bestDistance, progress: Math.min(1, Math.max(0, (metrics.startDistance - bestDistance) / (metrics.startDistance - close))) };
  }
  const attempts = observeAttempt(p.session.attempts!, a.attemptId, justStarted || !contiguous ? 0 : gap, frame.wallTime, metrics);
  p = { ...p, session: settleOpposition({ ...p.session, attempts }) };
  state.closeSince = reading!.closed ? state.closeSince ?? now : null;
  const returned = reading!.open && (state.baseline - distance) / (state.baseline - close) <= R.intentRatio / 2;
  state.returnSince = returned ? state.returnSince ?? now : null;
  p = { ...p, oppositionState: state };
  if (state.closeSince !== null && now - state.closeSince >= R.confirmMs) return terminal(p, 'completed', 'confirmed', frame.wallTime);
  if (attempts.active!.activeMs >= R.maxActiveMs) return terminal(p, observedOutcome(attempts.active!), 'timeout', frame.wallTime);
  if (state.returnSince !== null && now - state.returnSince >= R.readyMs) return terminal(p, observedOutcome(attempts.active!), 'returned', frame.wallTime);
  return p;
}

export function oppositionInstruction(p: Program): string {
  if (p.phase === 'paused') return p.pauseReason === 'tracking'
    ? 'Рука потеряна. Верни её и разведи пальцы: повторим ту же пару' : 'Тренировка на паузе. Нажми «Продолжить»';
  const task = pairTask(currentPair(p.session));
  if (p.session.opposition!.awaitingRelease) {
    const a = p.session.attempts!.records.find(a => a.settings.sequenceIndex === p.session.opposition!.cursor && consumesPair(a));
    const result = a?.outcome === 'partial' ? 'Частичный результат сохранён.' : a?.outcome === 'incomplete' ? 'Попытка сохранена.' : a?.endReason === 'skip' ? 'Пара пропущена.' : 'Пара выполнена.';
    return `${result} Разведи пальцы перед следующим заданием`;
  }
  if (p.oppositionState.baseline === null) return `Сначала разведи большой и выбранный пальцы. Затем: ${task.toLowerCase()}`;
  return p.session.attempts!.active ? `${task}. Можно закончить попытку с текущим результатом` : task;
}

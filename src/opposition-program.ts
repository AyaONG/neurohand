import { goalLink, goalRows, successText } from './goals';
import type { Program, ProgramFrame } from './program';
import type { Attempt, AttemptEndReason, AttemptOutcome } from './attempts';
import { closeActive, finishAttempt, interruptAttempt, observeAttempt, observedOutcome, startAttempt } from './attempts';
import { consumesPair, currentPair, PAIR_RULES as R, ALL_PAIR_KEYS, experimentalPair, pairRules, pairOf, pairDistances, pairTask, readOpposition, settleOpposition } from './opposition';

export type OppositionState = { baseline: number | null; openSince: number | null;
  intentSince: number | null; intentWall: string | null; closeSince: number | null; returnSince: number | null;
  baselineDistances?: Record<string, number>; movementKey?: import('./opposition').PairKey;
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
  const movementKey = state.movementKey ?? tip;
  return { attemptId: crypto.randomUUID(), ...goalLink(p.session), exerciseId: 'opposition', protocolVersion: p.session.protocolId,
    recognizerVersion: p.session.recognitionVersion, hand: p.session.hand, rulesVersion: pairRules(tip).version,
    settings: { target: p.session.opposition!.sequence.length, holdTargetMs: p.session.settings.holdTargetMs,
      targetRadiusRatio: p.session.settings.targetRadiusRatio, maxActiveMs: R.maxActiveMs,
      ...(skipped ? {} : { movementPair: pairOf(movementKey),
        movementStartDistance: movementKey === tip ? state.baseline! : state.baselineDistances![String(movementKey)] }),
      pairTip: tip, pair: pairOf(tip), pairRule: pairRules(tip).version, sequenceIndex: p.session.opposition!.cursor, partialRatio: R.partialRatio },
    startedAt: skipped ? wallTime : state.intentWall!, lastObservedAt: wallTime, endedAt: null, outcome: null, endReason: null,
    activeMs: skipped ? 0 : p.lastTimestamp! - state.intentSince!, validTrackingMs: skipped ? 0 : p.lastTimestamp! - state.intentSince!,
    interruptions: { count: 0, durationMs: 0 },
    metrics: skipped ? { kind: 'skipped', progress: 0 } : { kind: 'closure', startDistance: state.baseline!,
      successDistance: pairRules(tip).close, bestDistance: state.baseline!, progress: 0 } };
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
  const reading = g ? readOpposition(g, currentPair(previous.session), previous.oppositionState.baselineDistances) : null;
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
  const tip = currentPair(p.session), distance = g.nd(...pairOf(tip)), rule = pairRules(tip), close = rule.close;
  const sample = () => {
    state.samples.push({ at: now, distance });
    while (state.samples.length > 1 && state.samples[1].at <= now - R.filterMs) state.samples.shift();
  };
  if (experimentalPair(tip) && reading?.error?.code === 'AMBIGUOUS_PAIR' && p.session.attempts!.active) {
    return terminal(p, 'unscorable', 'tracking', frame.wallTime);
  }
  if (p.session.opposition!.awaitingRelease) {
    state.openSince = reading!.open ? state.openSince ?? now : null;
    if (state.openSince !== null && now - state.openSince >= R.readyMs) {
      // The old target remains visible until release is actually observed, including after reload.
      return { ...p, success: null, phase: 'preparing', oppositionState: emptyOppositionState(),
        session: { ...p.session, opposition: { ...p.session.opposition!, cursor: p.session.opposition!.cursor + Number(p.session.attempts!.records.some(a => a.settings.sequenceIndex === p.session.opposition!.cursor && consumesPair(a))), awaitingRelease: false } } };
    }
    return { ...p, oppositionState: state };
  }
  if (state.baseline === null) {
    const last = p.session.attempts!.records.at(-1);
    const retryBaseline = last?.goalId && last.settings.sequenceIndex === p.session.opposition!.cursor && last.metrics.kind === 'closure'
      ? last.metrics.startDistance : null;
    const movement = last?.settings.movementPair;
    const movementNotReturned = last?.goalId && last.settings.sequenceIndex === p.session.opposition!.cursor && movement &&
      g.nd(...movement) < last.settings.movementStartDistance! - rule.minRange / 4;
    if (!reading!.open || movementNotReturned || (retryBaseline !== null && distance < retryBaseline - rule.minRange / 4)) return { ...p, phase: 'preparing', oppositionState: emptyOppositionState() };
    state.openSince ??= now; sample();
    if (now - state.openSince >= R.readyMs) {
      const values = state.samples.map(s => s.distance).sort((a, b) => a - b);
      const baseline = values[Math.floor(values.length / 2)];
      if (baseline - close >= rule.minRange) state = { ...state, baseline, baselineDistances: pairDistances(g), samples: [], openSince: null };
    }
    return { ...p, phase: state.baseline === null ? 'preparing' : 'exercise', oppositionState: state };
  }
  if (reading!.error) state.samples = []; else sample();
  let justStarted = false;
  if (!p.session.attempts!.active) {
    const moved = (state.baseline - distance) / (state.baseline - close) >= rule.intentRatio;
    if ((!moved && reading!.error?.code !== 'WRONG_FINGER') || reading!.error?.code === 'AMBIGUOUS_PAIR') return { ...p, oppositionState: { ...state, intentSince: null, intentWall: null } };
    const movementKey = moved && !reading!.error ? tip : ALL_PAIR_KEYS.find(key => key !== tip &&
      state.baselineDistances && state.baselineDistances[String(key)] - g.nd(...pairOf(key)) >= Math.max(0.1, pairRules(key).minRange) &&
      g.nd(...pairOf(key)) < pairRules(key).close) ?? tip;
    if (state.movementKey !== undefined && state.movementKey !== movementKey) {
      state.intentSince = null; state.intentWall = null;
    }
    state.movementKey = movementKey;
    state.intentSince ??= now; state.intentWall ??= frame.wallTime;
    if (now - state.intentSince < rule.intentMs) return { ...p, oppositionState: state };
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
  const returned = reading!.open && (state.baseline - distance) / (state.baseline - close) <= rule.intentRatio / 2;
  state.returnSince = returned ? state.returnSince ?? now : null;
  p = { ...p, oppositionState: state };
  if (state.closeSince !== null && now - state.closeSince >= rule.confirmMs) return terminal(p, 'completed', 'confirmed', frame.wallTime);
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
    const row = goalRows(p.session.attempts)?.find(g => g.goalId === a?.goalId);
    const result = row?.completed ? successText(row.toSuccess) + '.' : a?.outcome === 'partial' ? 'Частичный результат сохранён.' : a?.outcome === 'incomplete' ? 'Попытка сохранена.' : a?.endReason === 'skip' ? 'Пара пропущена.' : 'Пара выполнена.';
    return `${result} Разведи пальцы перед следующим заданием`;
  }
  if (p.oppositionState.baseline === null) {
    const last = p.session.attempts?.records.at(-1);
    const retry = last && last.settings.sequenceIndex === p.session.opposition!.cursor ? 'Попытка сохранена. Повтори ту же цель. ' : '';
    return `${retry}Сначала разведи пальцы. Затем: ${task.toLowerCase()}`;
  }
  return p.session.attempts!.active ? `${task}. Можно закончить попытку с текущим результатом` : task;
}

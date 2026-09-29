import type { RingSettings } from './ring';
import type { FingerTip } from './opposition';
import type { ExerciseId } from './types';

export type AttemptOutcome = 'completed' | 'partial' | 'incomplete' | 'unscorable' | 'cancelled';
export type AttemptEndReason = 'confirmed' | 'returned' | 'manual' | 'pause' | 'results' | 'visibility' | 'tracking' | 'camera' | 'reload' | 'resize' | 'timeout' | 'skip' | 'off_path' | 'jump';
export const ATTEMPT_RULES = Object.freeze({
  version: 'basic-attempts-v1', intentRatio: 0.1, partialRatio: 0.2,
  stableMs: 100, minRange: 0.1, maxGapMs: 250, maxActiveMs: 10000,
  holdMovementRatio: 0.15,
});
export type AttemptMetrics =
  | { kind: 'ring'; marks: number; returned: boolean; pathLength: number; progress: number }
  | { kind: 'skipped'; progress: 0 }
  | { kind: 'closure'; startDistance: number; successDistance: number; bestDistance: number; progress: number }
  | { kind: 'hold'; bestHoldMs: number; targetMs: number; progress: number };
export type Attempt = {
  attemptId: string; exerciseId: ExerciseId; protocolVersion: string; recognizerVersion: string;
  hand: 'left' | 'right' | 'unspecified'; rulesVersion: string;
  settings: { target: number; holdTargetMs: number; targetRadiusRatio: number; maxActiveMs: number; pairTip?: FingerTip; sequenceIndex?: number; partialRatio?: number; ring?: RingSettings };
  startedAt: string; lastObservedAt: string; endedAt: string | null;
  outcome: AttemptOutcome | null; endReason: AttemptEndReason | null;
  activeMs: number; validTrackingMs: number;
  interruptions: { count: number; durationMs: number };
  metrics: AttemptMetrics;
};
export type AttemptLog = { historyComplete: boolean; records: Attempt[]; active: Attempt | null };
export const emptyAttempts = (historyComplete = true): AttemptLog => ({ historyComplete, records: [], active: null });

export function startAttempt(log: AttemptLog, attempt: Attempt): AttemptLog {
  if (log.active || log.records.some(a => a.attemptId === attempt.attemptId)) return log;
  return { ...log, active: attempt };
}

/** The caller supplies only adjacent, valid observations; never wall-clock elapsed time. */
export function observeAttempt(log: AttemptLog, attemptId: string, dtMs: number, wallTime: string, metrics: AttemptMetrics): AttemptLog {
  const a = log.active;
  if (!a || a.attemptId !== attemptId || !Number.isFinite(dtMs) || dtMs < 0 || dtMs > ATTEMPT_RULES.maxGapMs ||
      !Number.isFinite(Date.parse(wallTime)) || Date.parse(wallTime) < Date.parse(a.lastObservedAt)) return log;
  return { ...log, active: { ...a, activeMs: a.activeMs + dtMs, validTrackingMs: a.validTrackingMs + dtMs,
    lastObservedAt: wallTime, metrics } };
}

export function observedOutcome(a: Attempt): AttemptOutcome {
  if (a.metrics.kind === 'ring' && a.metrics.marks > 0) return 'partial';
  if (a.metrics.progress >= (a.exerciseId === 'opposition' ? a.settings.partialRatio! : ATTEMPT_RULES.partialRatio)) return 'partial';
  return a.validTrackingMs >= ATTEMPT_RULES.stableMs ? 'incomplete' : 'cancelled';
}

/** One terminal event per id. A progress value of 1 is not confirmation. */
export function finishAttempt(log: AttemptLog, attemptId: string, outcome: AttemptOutcome, reason: AttemptEndReason, wallTime: string): AttemptLog {
  const a = log.active;
  if (!a || a.attemptId !== attemptId || log.records.some(r => r.attemptId === attemptId) ||
      ((outcome === 'completed') !== (reason === 'confirmed'))) return log;
  const endedAt = Number.isFinite(Date.parse(wallTime)) && Date.parse(wallTime) >= Date.parse(a.lastObservedAt) ? wallTime : a.lastObservedAt;
  return { ...log, active: null, records: [...log.records, { ...a, endedAt, outcome, endReason: reason }] };
}

export function closeActive(log: AttemptLog | null, reason: AttemptEndReason, wallTime?: string): AttemptLog | null {
  if (!log?.active) return log;
  const unscorable = ['tracking', 'camera', 'reload', 'visibility', 'resize', 'jump'].includes(reason);
  return finishAttempt(log, log.active.attemptId, unscorable ? 'unscorable' : observedOutcome(log.active), reason, wallTime ?? log.active.lastObservedAt);
}

export function interruptAttempt(log: AttemptLog | null, dtMs: number, first: boolean): AttemptLog | null {
  if (!log?.active || !Number.isFinite(dtMs) || dtMs < 0) return log;
  const a = log.active;
  return { ...log, active: { ...a, interruptions: {
    count: a.interruptions.count + Number(first), durationMs: a.interruptions.durationMs + dtMs,
  } } };
}

export function attemptSummary(log: AttemptLog | null, confirmedCount?: number): string {
  if (!log) return 'Количество попыток в этой версии не записывалось.';
  const n = (outcome: AttemptOutcome) => log.records.filter(a => a.outcome === outcome).length;
  return `${log.historyComplete ? '' : 'До обновления количество попыток неизвестно. После обновления: '}` +
    `Оценено попыток: ${n('completed') + n('partial') + n('incomplete')}. ${n('completed')} выполнено · ${n('partial')} частично · ${n('incomplete')} не завершено. ` +
    `Не удалось оценить: ${n('unscorable')}. Отменено: ${n('cancelled')}.` +
    (log.active ? ' Есть активная попытка.' : '') +
    (log.historyComplete && confirmedCount !== undefined && confirmedCount > n('completed')
      ? ` Ещё подтверждено действий: ${confirmedCount - n('completed')}; начало этих попыток не зафиксировано.` : '');
}

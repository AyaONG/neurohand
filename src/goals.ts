import type { Attempt, AttemptLog } from './attempts';
import type { Session } from './session';
import type { ExerciseId } from './types';

export type ExerciseRun = { exerciseRunId: string; exerciseId: ExerciseId; goalIds: string[] };
export function createRuns(targets: [ExerciseId, number][]): ExerciseRun[] {
  return targets.map(([exerciseId, count]) => ({ exerciseRunId: crypto.randomUUID(), exerciseId,
    goalIds: Array.from({ length: count }, () => crypto.randomUUID()) }));
}
/** Absent runs means legacy unknown associations, never reconstructed from success counters. */
export function goalLink(s: Session, index?: number) {
  const run = s.attempts?.runs?.find(r => r.exerciseId === s.currentExercise);
  const i = index ?? (s.mode === 'opposition' ? s.opposition!.cursor : s.mode === 'ring' ? 0 : s.exercises[s.currentExercise]!.reps);
  if (!run || !run.goalIds[i]) return {};
  const goalId = run.goalIds[i];
  return { exerciseRunId: run.exerciseRunId, goalId,
    attemptOrder: (s.attempts?.records.filter(a => a.goalId === goalId).length ?? 0) + 1 };
}
export const evaluatedAttempt = (a: Attempt) => ['completed', 'partial', 'incomplete'].includes(a.outcome ?? '');
export function goalRows(log: AttemptLog | null) {
  return log?.runs?.flatMap(run => run.goalIds.map((goalId, index) => {
    const attempts = log.records.filter(a => a.goalId === goalId);
    const success = attempts.findIndex(a => a.outcome === 'completed');
    return { exerciseId: run.exerciseId, goalId, index, attempts, completed: success >= 0,
      toSuccess: success < 0 ? null : attempts.slice(0, success + 1).filter(evaluatedAttempt).length };
  })) ?? null;
}
export function successText(n: number | null) {
  if (n === null) return 'Пока не выполнено';
  const words: Record<number, string> = { 1: 'первой', 2: 'второй', 3: 'третьей', 4: 'четвёртой', 5: 'пятой' };
  return `Выполнено с ${words[n] ?? n + '-й'} попытки`;
}
export function currentGoalText(s: Session) {
  const link = goalLink(s);
  const run = s.attempts?.runs?.find(r => r.exerciseId === s.currentExercise);
  if (!run || !link.goalId) return '';
  const rows = goalRows(s.attempts)!;
  const row = rows.find(g => g.goalId === link.goalId)!;
  return `Цель ${row.index + 1} из ${run.goalIds.length} · ${row.completed ? successText(row.toSuccess) : 'Попытка ' + (s.attempts?.active?.goalId === link.goalId ? s.attempts.active.attemptOrder : link.attemptOrder)}`;
}

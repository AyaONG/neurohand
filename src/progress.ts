import type { Session } from './session';
import type { ExerciseId } from './types';
import type { Attempt, AttemptEndReason } from './attempts';
import { FINGER_NAMES } from './opposition';
import { RING_NAMES } from './ring';

export const EXERCISE_LABELS: Record<ExerciseId, string> = { pinch: 'Пинцет', grip: 'Сжатия', hold: 'Перенос', opposition: 'Найди пару', ring: 'Обведи кольцо' };
export type ExerciseFilter = ExerciseId | 'all';
export const exerciseIds = (s: Session): ExerciseId[] => s.mode === 'guided' ? ['pinch', 'grip', 'hold'] : [s.mode];
export const selectedIds = (s: Session, exercise: ExerciseFilter) => exerciseIds(s).filter(id => exercise === 'all' || id === exercise);
export const selectedAttempts = (s: Session, exercise: ExerciseFilter = 'all') => s.attempts?.records.filter(a => exercise === 'all' || a.exerciseId === exercise) ?? [];
export const evaluated = (a: Attempt) => ['completed', 'partial', 'incomplete'].includes(a.outcome!);
export function attemptCounts(s: Session, exercise: ExerciseFilter = 'all') {
  const records = selectedAttempts(s, exercise);
  const n = (status: string) => records.filter(a => a.outcome === status).length;
  const skipped = records.filter(a => a.endReason === 'skip').length;
  return { known: s.attempts !== null, complete: s.attempts?.historyComplete ?? false,
    evaluated: records.filter(evaluated).length, completed: n('completed'), partial: n('partial'), incomplete: n('incomplete'),
    unscorable: n('unscorable'), skipped, cancelled: n('cancelled') - skipped };
}
export function attemptText(s: Session, exercise: ExerciseFilter = 'all'): string {
  const c = attemptCounts(s, exercise);
  if (!c.known) return 'Количество попыток в этой версии не записывалось.';
  return `${c.complete ? '' : 'До обновления попытки неизвестны. После обновления: '}` +
    `Оценено: ${c.evaluated} · выполнено: ${c.completed} · частично: ${c.partial} · не завершено: ${c.incomplete}. ` +
    `Пропуски: ${c.skipped} · остановлено: ${c.cancelled} · не удалось оценить: ${c.unscorable}.`;
}
export function ringMetric(s: Session): string {
  const assessed = selectedAttempts(s, 'ring').filter(evaluated).flatMap(a => a.metrics.kind === 'ring' ? [a.metrics.marks] : []);
  const observed = selectedAttempts(s, 'ring').filter(a => a.outcome === 'unscorable').flatMap(a => a.metrics.kind === 'ring' ? [a.metrics.marks] : []);
  return `Полных кругов: ${s.exercises.ring?.reps ?? 0}. Лучший оценённый путь: ${assessed.length ? `${Math.max(...assessed)} / 12` : 'Недостаточно данных'}.` +
    (observed.length ? ` При сбоях наблюдалось до ${Math.max(...observed)} / 12; это не оценённый круг.` : '');
}
export function metricText(s: Session, exercise: ExerciseFilter = 'all'): string {
  return selectedIds(s, exercise).map(id => {
    const r = s.exercises[id]!;
    if (id === 'ring') return ringMetric(s);
    if (id === 'opposition') return `Пары: ${r.reps}/${r.target} полностью · частично: ${attemptCounts(s, id).partial}`;
    return `${EXERCISE_LABELS[id]}: ${r.started ? `${r.reps}/${r.target}` : 'Не начато'}`;
  }).join(' · ');
}
export const activeSeconds = (s: Session, exercise: ExerciseFilter = 'all') => (selectedIds(s, exercise).reduce((n, id) => n + s.exercises[id]!.activeMs, 0) / 1000).toFixed(1);

/** Stable identity of recorded conditions; never infer missing legacy attempt rules. */
export function conditionsKey(s: Session, exercise: ExerciseFilter = 'all'): string {
  const ids = selectedIds(s, exercise);
  const rules = ids.map(id => [id, [...new Set(selectedAttempts(s, id).map(a => JSON.stringify([
    a.rulesVersion, a.protocolVersion, a.recognizerVersion, a.settings.maxActiveMs, a.settings.partialRatio ?? null, a.settings.target, a.settings.holdTargetMs, a.settings.targetRadiusRatio,
  ])))].sort()]);
  return JSON.stringify([s.attempts?.runs ? 'goals-v1' : 'legacy-goals-unknown', ids, s.mode, s.hand, s.protocolId, s.recognitionVersion,
    s.settings, s.opposition ? [s.opposition.rulesVersion, s.opposition.allowed, s.opposition.sequence] : null,
    s.ring ?? null, s.attempts?.historyComplete ?? null, rules]);
}
export function knownRules(s: Session, exercise: ExerciseFilter): boolean {
  return s.mode === 'ring' ? !!s.ring?.rulesVersion : s.mode === 'opposition' ? !!s.opposition?.rulesVersion :
    selectedIds(s, exercise).every(id => selectedAttempts(s, id).some(a => !!a.rulesVersion));
}
export function conditionLabel(s: Session): string {
  if (s.ring) return `Кольцо · ${RING_NAMES[s.ring.tip]} · коридор ±${Math.round(s.ring.corridorRatio * 100)}% радиуса · ${s.ring.maxActiveMs / 1000} с · ${s.ring.rulesVersion}`;
  if (s.opposition) return `Пары: ${s.opposition.allowed.map(t => FINGER_NAMES[t]).join(', ')} · ${s.opposition.sequence.length} заданий · ${s.opposition.rulesVersion}`;
  return `Базовая программа ${s.settings.pinchTarget}/${s.settings.gripTarget}/${s.settings.holdTargetCount} · удержание ${s.settings.holdTargetMs / 1000} с${knownRules(s, 'all') ? '' : ' · версия правил попыток не записана'}`;
}
export function comparableResults(a: Session, b: Session, exercise: ExerciseFilter = 'all'): boolean {
  return knownRules(a, exercise) && knownRules(b, exercise) && a.status === 'completed' && b.status === 'completed' && a.hand !== 'unspecified' &&
    selectedIds(a, exercise).length > 0 && conditionsKey(a, exercise) === conditionsKey(b, exercise);
}
export type HistoryFilter = { exercise: ExerciseFilter; hand: Session['hand'] | 'all'; seriesId: string };
export const defaultFilter = (): HistoryFilter => ({ exercise: 'all', hand: 'all', seriesId: '' });
export function filterHistory(history: Session[], filter: HistoryFilter): Session[] {
  const reference = history.find(s => s.id === filter.seriesId);
  return history.filter(s => selectedIds(s, filter.exercise).length && (filter.hand === 'all' || s.hand === filter.hand) &&
    (!reference || conditionsKey(s, filter.exercise) === conditionsKey(reference, filter.exercise)))
    .sort((a, b) => Date.parse(b.endedAt!) - Date.parse(a.endedAt!));
}
export const END_REASONS: Record<AttemptEndReason, string> = { confirmed: 'подтверждено', returned: 'возврат в исходную позу', manual: 'завершено вручную', pause: 'пауза', results: 'просмотр итогов', visibility: 'вкладка скрыта', tracking: 'потеря руки', camera: 'камера недоступна', reload: 'перезагрузка', resize: 'размер экрана изменён', timeout: 'время истекло', skip: 'явный пропуск', off_path: 'выход из коридора / неверное направление', jump: 'скачок координат' };
export function attemptDetail(a: Attempt, debug = false): string {
  const outcomes = { completed: 'Выполнено', partial: 'Выполнено частично', incomplete: 'Попытка не завершена', unscorable: 'Не удалось оценить', cancelled: 'Остановлено' };
  const target = a.exerciseId === 'opposition' ? `Большой + ${FINGER_NAMES[a.settings.pairTip!]}` : a.exerciseId === 'ring' ? `Кольцо · ${RING_NAMES[a.settings.ring!.tip]}` : EXERCISE_LABELS[a.exerciseId];
  const m = a.metrics;
  const metric = m.kind === 'ring' ? `${m.marks} / 12 отметок · ${m.returned ? 'с возвратом' : 'без подтверждённого возврата'}` :
    m.kind === 'hold' ? `удержание ${(m.bestHoldMs / 1000).toFixed(1)} / ${(m.targetMs / 1000).toFixed(1)} с` :
    m.kind === 'closure' ? debug ? `сближение ${m.startDistance.toFixed(2)} → ${m.bestDistance.toFixed(2)} (нормированное расстояние)` : 'движение пальцев' : 'без измерения движения';
  return `${target} — ${a.endReason === 'skip' ? 'Пропущено' : a.outcome ? outcomes[a.outcome] : 'Активна'} · ${metric} · активное время ${(a.activeMs / 1000).toFixed(1)} с · ${debug && a.endReason ? a.endReason : a.outcome === 'unscorable' ? 'помешал сбой отслеживания' : ''}`;
}

import type { Session } from './session';
import { goalRows } from './goals';
import { CLOSURE_LABELS } from './flow';
import { attemptCounts, attemptDetail, EXERCISE_LABELS, selectedIds, type ExerciseFilter } from './progress';
import { pairLabel } from './opposition';
export type ReportOptions = { exercise?: ExerciseFilter; filterLabel?: string; timeZone?: string; generatedAt?: Date; synthetic?: boolean };
export type ReportLine = { text: string; style: 'title' | 'heading' | 'body' | 'muted' };
export function reportLines(sessions: Session[], options: ReportOptions = {}): ReportLine[] {
  const lines: ReportLine[] = [];
  const add = (text: string, style: ReportLine['style'] = 'body') => lines.push({ text, style });
  const zone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const stamp = (time: string) => new Date(time).toLocaleString('ru-RU', { timeZone: zone });
  const exercise = options.exercise ?? 'all';
  add('NeuroHand | Отчёт о занятиях', 'title');
  if (options.synthetic) add('ДЕМОНСТРАЦИОННЫЕ ДАННЫЕ. Это не история пользователя.', 'heading');
  add(`Сформирован: ${stamp((options.generatedAt ?? new Date()).toISOString())}. Часовой пояс: ${zone}`, 'muted');
  add(options.filterLabel ?? 'Выборка: выбранное занятие', 'muted');
  add('Результаты описывают выполнение заданий, не степень восстановления. Завершение маршрута не означает выполнение всех целей.', 'muted');
  if (!sessions.length) add('За выбранный период и по этим фильтрам занятий нет.');
  for (const [index,s] of sessions.entries()) {
    const ids = selectedIds(s, exercise), c = attemptCounts(s, exercise), rows = goalRows(s.attempts)?.filter(g => ids.includes(g.exerciseId));
    const flow = s.attempts?.flow;
    add(`Занятие ${index + 1} | ${ids.map(id => EXERCISE_LABELS[id]).join(', ')}`, 'heading');
    add(`Начало: ${stamp(s.startedAt)}. Окончание: ${s.endedAt ? stamp(s.endedAt) : 'занятие ещё не закончено'}.`);
    add(`Рука: ${{left:'левая',right:'правая',unspecified:'не указана'}[s.hand]}. Статус: ${{completed:'маршрут завершён',stopped:'остановлено',in_progress:'в процессе'}[s.status]}.`);
    const route = s.attempts?.route;
    if (route) add(`Маршрут: ${route.blocks.map(b => b.mode === 'guided' ? 'Базовая программа' : EXERCISE_LABELS[b.mode]).join(' / ')}. Блок ${route.index + 1} из ${route.blocks.length}.`);
    add(`Переходы: ${flow ? flow.automatic ? 'автоматические; до 2 оценённых попыток, 20 с на цель без пауз и потери руки' : 'ручной режим без лимита повторов' : 'нет данных о настройке'}.`);
    add(`Цели выполнены: ${rows ? `${rows.filter(g => g.completed).length} / ${rows.length}` : 'нет данных о связях целей'}.`);
    if (c.known) {
      add(`${c.complete ? '' : 'Учтена только записанная часть истории. '}Оценённые попытки: ${c.evaluated}. Полные: ${c.completed}. Частичные: ${c.partial}. Неполные: ${c.incomplete}.`);
      add(`Не удалось оценить: ${c.unscorable}. Отмены попыток: ${c.cancelled}. Ручные пропуски: ${c.skipped}.`);
    } else add('Оценённые попытки, частичные результаты, сбои и пропуски: нет данных.');
    add(`Автоматические переходы без успеха: ${flow && rows ? rows.filter(g => g.closure && !['success','manual_skip'].includes(g.closure)).length : 'нет данных'}.`);
    const active = s.attempts?.historyComplete ? s.attempts.records.filter(a => ids.includes(a.exerciseId)).reduce((n,a) => n+a.activeMs,0) + (s.attempts.active && ids.includes(s.attempts.active.exerciseId) ? s.attempts.active.activeMs : 0) : null;
    add(`Активное время измеренных попыток: ${active === null ? 'нет данных' : (active/1000).toFixed(1)+' с'}. Время от начала до окончания: ${s.endedAt ? ((Date.parse(s.endedAt)-Date.parse(s.startedAt))/1000).toFixed(1)+' с' : 'нет данных'}.`);
    if (active === null) add(`Ранее записанное время упражнений: ${(ids.reduce((n,id)=>n+s.exercises[id]!.activeMs,0)/1000).toFixed(1)} с; границы попыток неизвестны.`);
    if (!rows) {
      add('Связи целей и число повторов старой записи: нет данных.');
      ids.forEach(id=>add(`${EXERCISE_LABELS[id]}: подтверждённых действий ${s.exercises[id]!.reps} / ${s.exercises[id]!.target}.`));
      s.attempts?.records.filter(a=>ids.includes(a.exerciseId)).forEach(a=>add(attemptDetail(a).replace(/\s*·\s*$/, '')));
    } else for (const g of rows) {
      const name = g.exerciseId === 'opposition' && s.opposition ? pairLabel(s.opposition.sequence[g.index]) : EXERCISE_LABELS[g.exerciseId];
      const evaluated = g.attempts.filter(a=>['completed','partial','incomplete'].includes(a.outcome!)).length;
      const unscorable = g.attempts.filter(a=>a.outcome === 'unscorable').length;
      const cancelled = g.attempts.filter(a=>a.outcome === 'cancelled').length;
      add(`Цель ${g.index + 1}: ${name}`, 'heading');
      add(`${g.completed ? `Выполнено; оценённых попыток до успеха: ${g.toSuccess}` : 'Пока не выполнено'}. Оценено: ${evaluated}; сбои: ${unscorable}; отмены: ${cancelled}.`);
      add(`Завершение цели: ${g.closure ? CLOSURE_LABELS[g.closure] : flow ? 'цель не закрыта' : g.completed ? 'успех' : 'нет данных'}.`);
      g.attempts.forEach((a,i)=>add(`Попытка ${i+1}: ${attemptDetail(a).replace(/\s*·\s*$/, '')}`));
    }
  }
  return lines;
}

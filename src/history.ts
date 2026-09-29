import { activeSeconds, attemptText, comparableResults, conditionsKey, conditionLabel, defaultFilter, EXERCISE_LABELS, filterHistory, metricText, type ExerciseFilter, type HistoryFilter } from './progress';
import type { Session } from './session';
import { type ProgressStore } from './storage';
import { renderResults, getResults } from './results';

const ids = ['pinch', 'grip', 'hold'] as const;
const titles = ['Пинцет', 'Сжатия', 'Цели'];
const hands = { left: 'Левая', right: 'Правая', unspecified: 'Не выбрана' };
const statuses = { completed: 'Завершена', stopped: 'Остановлена', in_progress: 'На паузе' };
const stamp = (s: Session) => new Date(s.endedAt ?? s.startedAt).toLocaleString('ru-RU');
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function activity(history: Session[], now = new Date()) {
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6 + i, 12);
    const records = history.filter(s => localDay(new Date(s.endedAt ?? s.startedAt)) === localDay(day));
    return { day: localDay(day), label: day.toLocaleDateString('ru-RU'),
      completed: records.filter(s => s.status === 'completed').length,
      partial: records.filter(s => s.status === 'stopped').length };
  });
}
export function comparison(history: Session[], exercise: ExerciseFilter = 'all'): [Session, Session] | null {
  const sorted = [...history].sort((a, b) => Date.parse(b.endedAt!) - Date.parse(a.endedAt!));
  for (const [i, newer] of sorted.entries()) {
    const older = sorted.slice(i + 1).find(s => comparableResults(newer, s, exercise));
    if (older) return [older, newer];
  }
  return null;
}
const element = (tag: string, text = '') => { const node = document.createElement(tag); node.textContent = text; return node; };
function table(headers: string[], rows: string[][]): HTMLElement {
  const wrapper = element('div'); wrapper.className = 'table-scroll'; wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'region'); wrapper.setAttribute('aria-label', headers.join(', '));
  const t = element('table'); const head = element('thead'); const tr = element('tr');
  headers.forEach(text => { const th = element('th', text); th.setAttribute('scope', 'col'); tr.append(th); });
  head.append(tr); t.append(head); const body = element('tbody');
  rows.forEach(row => { const tr = element('tr'); row.forEach(text => tr.append(element('td', text))); body.append(tr); });
  t.append(body); wrapper.append(t); return wrapper;
}
export function renderHistory(container: HTMLElement, store: ProgressStore, onBack: () => void, filter: HistoryFilter = defaultFilter(), page = 0, focusId?: string): void {
  const heading = element('h2', 'Мой прогресс'); heading.tabIndex = -1;
  const back = element('button', 'К тренировке'); back.id = 'btn-history-back'; back.addEventListener('click', onBack);
  container.replaceChildren(heading, back,
    element('p', 'История хранится в этом браузере на этом адресе, включая порт. Между устройствами не синхронизируется. Показ по 30 занятий; остальные записи доступны на следующих страницах.'),
    element('p', store.notice));
  const matching = filterHistory(store.data.history, { ...filter, seriesId: '' });
  const history = filterHistory(store.data.history, filter);
  const pages = Math.max(1, Math.ceil(history.length / 30));
  page = Math.max(0, Math.min(page, pages - 1));
  const visible = history.slice(page * 30, (page + 1) * 30);
  const controls = element('div'); controls.className = 'history-filters';
  function select(id: string, title: string, choices: [string, string][], value: string, change: (value: string) => HistoryFilter) {
    const label = element('label', title), input = document.createElement('select'); input.id = id;
    choices.forEach(([value, text]) => { const option = document.createElement('option'); option.value = value; option.textContent = text; input.append(option); });
    input.value = value;
    input.addEventListener('change', () => renderHistory(container, store, onBack, change(input.value), 0, id));
    label.append(input); controls.append(label);
  }
  select('history-exercise', 'Упражнение', [['all', 'Все упражнения'], ...Object.entries(EXERCISE_LABELS)], filter.exercise,
    value => ({ ...filter, exercise: value as ExerciseFilter, seriesId: '' }));
  select('history-hand', 'Рука', [['all', 'Все руки'], ...Object.entries(hands)], filter.hand,
    value => ({ ...filter, hand: value as HistoryFilter['hand'], seriesId: '' }));
  const unique = new Map<string, Session>();
  matching.forEach(s => { const key = conditionsKey(s, filter.exercise); if (!unique.has(key)) unique.set(key, s); });
  select('history-series', 'Одинаковые условия', [['', 'Все настройки'], ...[...unique.values()].map(s => [s.id, `Как занятие ${stamp(s)} · ${hands[s.hand]} · ${conditionLabel(s)}`] as [string, string])], filter.seriesId,
    value => ({ ...filter, seriesId: value }));
  container.append(controls, element('p', 'Статус занятия описывает завершение маршрута. Статусы попыток ниже показывают фактическое выполнение. Хранение: в этом браузере; облачная синхронизация не включена.'));
  if (store.data.history.length && !history.length) container.append(element('p', 'По выбранным фильтрам занятий нет. Измени упражнение или руку.'));

  if (!store.data.history.length) container.append(element('p', 'Завершённых тренировок пока нет. Начни тренировку — здесь появятся твои результаты.'));
  else if (history.length) {
    const last = history[0];
    container.append(element('h3', 'Последняя тренировка'), element('p', `${stamp(last)} · ${statuses[last.status]} · ${hands[last.hand]} · ${getResults(last).rows.filter(row => filter.exercise === 'all' || row.exercise === filter.exercise).map(row => row.text).join(' · ')}`));
  }
  if (store.data.current) container.append(element('p', `Текущая тренировка: ${stamp(store.data.current)}. Результаты доступны через «К тренировке».`));
  container.append(element('h3', '7 местных календарных дней'), table(['Дата', 'Завершённые', 'Остановленные'],
    activity(history).map(d => [d.label, d.completed ? `✓ ${d.completed}` : '—', d.partial ? `◦ ${d.partial}` : '—'])));
  container.append(element('h3', 'История'), table(['Дата и время', 'Рука', 'Статус занятия', 'Результаты упражнений', 'Статусы попыток', 'Активное время, с', 'Хранение'],
    visible.map(s => [stamp(s), hands[s.hand], statuses[s.status], metricText(s, filter.exercise), attemptText(s, filter.exercise), activeSeconds(s, filter.exercise), store.notice ? 'Доступно в памяти; см. сообщение хранилища' : 'В этом браузере'])));
  const navigation = element('div'); navigation.className = 'history-pages';
  const previous = document.createElement('button'), next = document.createElement('button');
  previous.id = 'history-previous'; previous.textContent = 'Предыдущие'; previous.disabled = page === 0;
  next.id = 'history-next'; next.textContent = 'Следующие'; next.disabled = page + 1 >= pages;
  previous.addEventListener('click', () => renderHistory(container, store, onBack, filter, page - 1, 'history-previous'));
  next.addEventListener('click', () => renderHistory(container, store, onBack, filter, page + 1, 'history-next'));
  navigation.append(previous, element('span', `Страница ${page + 1} из ${pages} · занятий: ${history.length}`), next); container.append(navigation);
  const details = element('section'); details.setAttribute('aria-label', 'Детали тренировки');
  for (const s of visible) {
    const button = element('button', `Детали: ${stamp(s)} · ${hands[s.hand]}`);
    button.addEventListener('click', () => {
      renderResults(details, s, () => {}, undefined, () => renderHistory(container, store, onBack, filter, page));
      // The historical result is read-only; its action returns to the list, never starts a camera.
      const action = details.querySelector<HTMLButtonElement>('#btn-new');
      if (action) action.textContent = 'К списку истории';
      details.append(element('p', `Начало: ${new Date(s.startedAt).toLocaleString('ru-RU')}. Протокол: ${s.protocolId}. Распознавание: ${s.recognitionVersion}. Рука: ${hands[s.hand]}.`));
    });
    container.append(button);
  }
  container.append(details, element('h3', 'Сопоставимые тренировки'));
  const pair = comparison(history, filter.exercise);
  if (pair) {
    container.append(element('p', `Одинаковые записанные настройки, версии правил и рука: ${hands[pair[0].hand]}. Сравниваются завершённые маршруты; частичные результаты допустимы. Это не оценка восстановления.`),
      table(['Показатель', stamp(pair[0]), stamp(pair[1])], [
        ['Конкретные результаты', ...pair.map(s => metricText(s, filter.exercise))],
        ['Статусы попыток', ...pair.map(s => attemptText(s, filter.exercise))],
        ['Активное время, с', ...pair.map(s => activeSeconds(s, filter.exercise))],
      ]));
  } else container.append(element('p', 'Недостаточно сопоставимых занятий. Нужны два завершённых маршрута с той же явно выбранной рукой, версией правил и настройками. Без записанной версии правил сравнение недоступно. Неизвестные попытки не восстанавливаются из счётчиков успехов.'));
  if (store.legacy && (filter.hand === 'all' || filter.hand === 'unspecified') && (filter.exercise === 'all' || ids.some(id => id === filter.exercise)) && !filter.seriesId) container.append(element('h3', 'Запись старой версии'), element('p', 'Дата, рука и настройки неизвестны. В сравнение и календарь не включена. Исходная запись сохранена.'),
    table(titles, [ids.map(id => store.legacy!.counters[id] === undefined ? 'Нет данных' : String(store.legacy!.counters[id]))]));
  if (focusId) container.querySelector<HTMLElement>(`#${focusId}`)?.focus(); else heading.focus();
}

import type { Session } from './session';
import { comparable, type ProgressStore } from './storage';
import { renderResults } from './results';

const ids = ['pinch', 'grip', 'hold'] as const;
const titles = ['Пинцет', 'Сжатия', 'Цели'];
const hands = { left: 'Левая', right: 'Правая', unspecified: 'Не выбрана' };
const statuses = { completed: 'Завершена', stopped: 'Остановлена', in_progress: 'На паузе' };
const active = (s: Session) => (ids.reduce((n, id) => n + s.exercises[id].activeMs, 0) / 1000).toFixed(1);
const prompts = (s: Session) => ids.reduce((n, id) => n + Object.values(s.exercises[id].promptEpisodes).reduce((a, b) => a + b, 0), 0);
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
export function comparison(history: Session[]): [Session, Session] | null {
  const sorted = [...history].sort((a, b) => Date.parse(b.endedAt!) - Date.parse(a.endedAt!));
  for (const [i, newer] of sorted.entries()) {
    const older = sorted.slice(i + 1).find(s => comparable(newer, s));
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
export function renderHistory(container: HTMLElement, store: ProgressStore, onBack: () => void): void {
  const heading = element('h2', 'Мой прогресс'); heading.tabIndex = -1;
  const back = element('button', 'К тренировке'); back.id = 'btn-history-back'; back.addEventListener('click', onBack);
  container.replaceChildren(heading, back,
    element('p', 'История хранится в этом браузере на этом адресе, включая порт. Между устройствами не синхронизируется. Последние 30 тренировок.'),
    element('p', store.notice));
  const history = store.data.history;
  if (!history.length) container.append(element('p', 'Завершённых тренировок пока нет. Начни тренировку — здесь появятся твои результаты.'));
  else {
    const last = history[0];
    container.append(element('h3', 'Последняя тренировка'), element('p', `${stamp(last)} · ${statuses[last.status]} · ${hands[last.hand]} · ${ids.map((id, i) => `${titles[i]}: ${last.exercises[id].started ? `${last.exercises[id].reps}/${last.exercises[id].target}` : 'Не начато'}`).join(' · ')}`));
  }
  if (store.data.current) container.append(element('p', `Текущая тренировка: ${stamp(store.data.current)}. Результаты доступны через «К тренировке».`));
  container.append(element('h3', '7 местных календарных дней'), table(['Дата', 'Завершённые', 'Частичные'],
    activity(history).map(d => [d.label, d.completed ? `✓ ${d.completed}` : '—', d.partial ? `◦ ${d.partial}` : '—'])));
  container.append(element('h3', 'История'), table(['Дата и время', 'Рука', 'Статус', ...titles, 'Активное время, с'],
    history.map(s => [stamp(s), hands[s.hand], statuses[s.status], ...ids.map(id => s.exercises[id].started ? `${s.exercises[id].reps}/${s.exercises[id].target}` : 'Не начато'), active(s)])));
  const details = element('section'); details.setAttribute('aria-label', 'Детали тренировки');
  for (const s of history) {
    const button = element('button', `Детали: ${stamp(s)} · ${hands[s.hand]}`);
    button.addEventListener('click', () => {
      renderResults(details, s, () => {}, undefined, () => renderHistory(container, store, onBack));
      // The historical result is read-only; its action returns to the list, never starts a camera.
      const action = details.querySelector<HTMLButtonElement>('#btn-new');
      if (action) action.textContent = 'К списку истории';
      details.append(element('p', `Начало: ${new Date(s.startedAt).toLocaleString('ru-RU')}. Протокол: ${s.protocolId}. Распознавание: ${s.recognitionVersion}. Рука: ${hands[s.hand]}.`));
    });
    container.append(button);
  }
  container.append(details, element('h3', 'Сопоставимые тренировки'));
  const pair = comparison(history);
  if (pair) {
    container.append(element('p', `Одинаковые настройки и рука: ${hands[pair[0].hand]}. Значения показаны без оценки улучшения.`),
      table(['Показатель', stamp(pair[0]), stamp(pair[1])], [
        ...ids.map((id, i) => [titles[i], ...pair.map(s => `${s.exercises[id].reps}/${s.exercises[id].target}`)]),
        ['Активное время, с', ...pair.map(active)], ['Эпизоды подсказок', ...pair.map(s => String(prompts(s)))],
        ['Лучшее удержание, с', ...pair.map(s => s.exercises.hold.bestHoldMs === null ? 'Нет данных' : (s.exercises.hold.bestHoldMs / 1000).toFixed(1))],
      ]));
  } else container.append(element('p', 'Заверши ещё одну тренировку с теми же настройками и явно выбранной рукой для сравнения. С неизвестной рукой сравнение недоступно.'));
  if (store.legacy) container.append(element('h3', 'Запись старой версии'), element('p', 'Дата, рука и настройки неизвестны. В сравнение и календарь не включена. Исходная запись сохранена.'),
    table(titles, [ids.map(id => store.legacy!.counters[id] === undefined ? 'Нет данных' : String(store.legacy!.counters[id]))]));
  heading.focus();
}

import { goalRows, successText } from './goals';
import { attemptDetail, attemptText, ringMetric } from './progress';
import { pairCounts } from './opposition';
import type { Session } from "./session";
import type { ExerciseId } from "./types";

const labels: Record<ExerciseId, string> = { pinch: "Пинцет", grip: "Сжатия", hold: "Перенос", opposition: "Найди пару", ring: "Обведи кольцо" };

export function getResults(session: Session): { empty: boolean; rows: { exercise: ExerciseId; text: string }[] } {
  if (session.mode === 'ring') {
    const a = session.attempts?.active ?? session.attempts?.records.at(-1);
    return { empty: !session.exercises.ring!.started, rows: [{ exercise: 'ring', text: `Обведи кольцо: ${a?.metrics.kind === 'ring' ? a.metrics.marks : 0} / 12 · ${a?.outcome === 'completed' ? 'полный путь с возвратом' : 'полный круг не подтверждён'}` }] };
  }
  if (session.mode === 'opposition') {
    const c = pairCounts(session);
    return { empty: !session.exercises.opposition!.started, rows: [{ exercise: 'opposition',
      text: `Цели выполнены: ${c.completed} / ${session.opposition!.sequence.length}` }] };
  }
  return {
    empty: Object.values(session.exercises).every(result => !result.started),
    rows: (["pinch", "grip", "hold"] as const).map(exercise => {
      const result = session.exercises[exercise];
      return { exercise, text: `${labels[exercise]}: ${result.started ? `${result.reps} / ${result.target}` : "Не начато"}` };
    }),
  };
}

/** A snapshot of session data; never reads numbers back from the DOM. */
export function renderResults(container: HTMLElement, session: Session, onResume: () => void, onFinish?: () => void, onNew?: () => void, storageText = 'В этом браузере'): void {
  const model = getResults(session);
  const heading = document.createElement("h2");
  heading.textContent = session.status === "completed" ? "Тренировка завершена" : session.status === "stopped" ? "Тренировка остановлена" : "Текущие итоги";
  heading.tabIndex = -1;
  const description = document.createElement("p");
  description.textContent = session.status === "completed" ? (session.mode !== 'guided' ? 'Маршрут занятия завершён. Ниже — фактически выполненные и частичные результаты.' : "Выполнено 3 из 3 заданий.") : session.status === "stopped" ? "Тренировка остановлена. Сохранён выполненный объём." : model.empty
    ? (session.mode === 'ring' ? 'Удержи кончик на старте кольца и начни движение по часовой стрелке.' : session.mode === 'opposition' ? 'Движений пока нет. Разведи пальцы, затем соедини указанную пару.' : "Движений пока нет. Начни с пинцета: раскрой ладонь, затем соедини большой и указательный пальцы.")
    : "Тренировка на паузе. Результаты сохранятся при продолжении.";
  const list = document.createElement("ul");
  list.className = session.mode !== "guided" ? "result-cards pair-results" : "result-cards";
  for (const row of model.rows) {
    const item = document.createElement("li");
    item.textContent = row.text;
    list.append(item);
  }
  const resume = document.createElement("button");
  resume.id = session.status === "in_progress" ? "btn-resume" : "btn-new";
  resume.textContent = session.status !== "in_progress" ? "Новая тренировка" : model.empty ? "К упражнениям" : "Продолжить";
  resume.addEventListener("click", session.status === "in_progress" ? onResume : onNew ?? onResume);
  const metrics = document.createElement("p");
  const activeMs = Object.values(session.exercises).reduce((sum, result) => sum + result.activeMs, 0);
  metrics.textContent = `Активное время: ${(activeMs / 1000).toFixed(1)} с.` + (session.mode !== 'guided' ? '' : ` Лучшее удержание: ${((session.exercises.hold.bestHoldMs ?? 0) / 1000).toFixed(1)} с.`);
  const exerciseIds: ExerciseId[] = session.mode === 'ring' ? ['ring'] : session.mode === 'opposition' ? ['opposition'] : ['pinch', 'grip', 'hold'];
  const prompts = document.createElement("p");
  const debug = typeof location !== "undefined" && new URLSearchParams(location.search).get("debug") === "1";
  prompts.hidden = !debug;
  prompts.textContent = exerciseIds.map(id => `${labels[id]} — эпизоды подсказок: ${session.exercises[id]!.started ? Object.values(session.exercises[id]!.promptEpisodes).reduce((a, b) => a + b, 0) : "Не начато"}`).join(". ");
  const notice = document.createElement("p");
  notice.id = "result-storage-status";
  notice.className = "results-note";
  notice.textContent = storageText;
  const disclaimer = document.createElement("p");
  disclaimer.className = "results-note";
  disclaimer.textContent = "Тренажёр не является медицинским устройством. Результаты описывают выполнение заданий.";
  container.replaceChildren(heading, description, list, resume, metrics, prompts);
  if (session.status === "in_progress" && onFinish) {
    const finish = document.createElement("button");
    finish.id = "btn-finish";
    finish.textContent = "Завершить тренировку";
    finish.addEventListener("click", onFinish);
    container.append(finish);
  }
  const details = document.createElement("ul");
  details.className = "result-times";
  for (const id of exerciseIds) {
    const item = document.createElement("li");
    const result = session.exercises[id]!;
    item.textContent = `${labels[id]} — ${result.started ? `активное время: ${(result.activeMs / 1000).toFixed(1)} с` : "Не начато"}`;
    details.append(item);
  }
  details.hidden = !debug;
  container.append(details, notice, disclaimer);
  const attemptHeading = document.createElement('h3'); attemptHeading.textContent = 'Статусы попыток';
  const breakdown = document.createElement('p'); breakdown.textContent = attemptText(session);
  const attemptList = document.createElement('ul');
  const goals = goalRows(session.attempts);
  if (goals) for (const goal of goals) {
    const item = document.createElement('li');
    item.textContent = `${labels[goal.exerciseId]} · Цель ${goal.index + 1}: ${successText(goal.toSuccess)}`;
    const children = document.createElement('ul');
    for (const a of goal.attempts) {
      const detail = document.createElement('li');
      detail.textContent = `Попытка ${a.attemptOrder}: ${attemptDetail(a, debug)}`;
      children.append(detail);
    }
    item.append(children); attemptList.append(item);
  }
  if (!goals) for (const a of session.attempts?.records ?? []) {
    const item = document.createElement('li'); item.textContent = attemptDetail(a, debug); attemptList.append(item);
  }
  container.append(attemptHeading, breakdown, attemptList);
  if (session.mode === 'ring') {
    const note = document.createElement('p');
    note.textContent = ringMetric(session) + ' Измеряется экранный путь кончика, не изолированное движение пальца.';
    container.append(note);
  }
  heading.focus();
}

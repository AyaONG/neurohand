import { pairCounts, FINGER_NAMES } from './opposition';
import { attemptSummary } from './attempts';
import type { Session } from "./session";
import type { ExerciseId } from "./types";

const labels: Record<ExerciseId, string> = { pinch: "Пинцет", grip: "Сжатия", hold: "Перенос", opposition: "Найди пару" };

export function getResults(session: Session): { empty: boolean; rows: { exercise: ExerciseId; text: string }[] } {
  if (session.mode === 'opposition') {
    const c = pairCounts(session);
    return { empty: !session.exercises.opposition!.started, rows: [{ exercise: 'opposition',
      text: `Найди пару: ${c.completed} / ${session.opposition!.sequence.length} полностью · ${c.partial} частично · ${c.incomplete} не завершено · ${c.skipped} пропущено` }] };
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
export function renderResults(container: HTMLElement, session: Session, onResume: () => void, onFinish?: () => void, onNew?: () => void): void {
  const model = getResults(session);
  const heading = document.createElement("h2");
  heading.textContent = session.status === "completed" ? "Тренировка завершена" : session.status === "stopped" ? "Тренировка остановлена" : "Текущие итоги";
  heading.tabIndex = -1;
  const description = document.createElement("p");
  description.textContent = session.status === "completed" ? (session.mode === 'opposition' ? 'Маршрут занятия завершён. Ниже — фактически выполненные и частичные результаты.' : "Выполнено 3 из 3 заданий.") : session.status === "stopped" ? "Тренировка остановлена. Сохранён выполненный объём." : model.empty
    ? (session.mode === 'opposition' ? 'Движений пока нет. Разведи пальцы, затем соедини указанную пару.' : "Движений пока нет. Начни с пинцета: раскрой ладонь, затем соедини большой и указательный пальцы.")
    : "Тренировка на паузе. Результаты сохранятся при продолжении.";
  const list = document.createElement("ul");
  list.className = session.mode === "opposition" ? "result-cards pair-results" : "result-cards";
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
  metrics.textContent = `Активное время: ${(activeMs / 1000).toFixed(1)} с.` + (session.mode === 'opposition' ? '' : ` Лучшее удержание: ${((session.exercises.hold.bestHoldMs ?? 0) / 1000).toFixed(1)} с.`);
  const exerciseIds: ExerciseId[] = session.mode === 'opposition' ? ['opposition'] : ['pinch', 'grip', 'hold'];
  const prompts = document.createElement("p");
  prompts.hidden = session.mode === "opposition";
  prompts.textContent = exerciseIds.map(id => `${labels[id]} — эпизоды подсказок: ${session.exercises[id]!.started ? Object.values(session.exercises[id]!.promptEpisodes).reduce((a, b) => a + b, 0) : "Не начато"}`).join(". ");
  const notice = document.createElement("p");
  notice.className = "results-note";
  notice.textContent = "История хранится в этом браузере на этом адресе. Синхронизации между устройствами нет.";
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
  const attempts = document.createElement('p');
  attempts.textContent = attemptSummary(session.attempts, Object.values(session.exercises).reduce((sum, r) => sum + r.reps, 0));
  container.append(details, attempts, notice, disclaimer);
  if (session.mode === 'opposition') {
    const outcomes = { completed: 'Выполнено', partial: 'Частично', incomplete: 'Не завершено', unscorable: 'Не удалось оценить', cancelled: 'Пропущено / остановлено' };
    const pairs = document.createElement('ul');
    for (const a of session.attempts!.records) {
      const row = document.createElement('li');
      row.textContent = `Большой + ${FINGER_NAMES[a.settings.pairTip!]} — ${outcomes[a.outcome!]} · ${(a.activeMs / 1000).toFixed(1)} с`;
      pairs.append(row);
    }
    container.append(pairs);
  }
  heading.focus();
}

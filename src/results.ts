import type { Session } from "./session";
import type { ExerciseId } from "./types";

const labels: Record<ExerciseId, string> = { pinch: "Пинцет", grip: "Сжатия", hold: "Перенос" };

export function getResults(session: Session): { empty: boolean; rows: { exercise: ExerciseId; text: string }[] } {
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
  description.textContent = session.status === "completed" ? "Выполнено 3 из 3 заданий." : session.status === "stopped" ? "Сохранён выполненный объём в текущей странице." : model.empty
    ? "Движений пока нет. Начни с пинцета: раскрой ладонь, затем соедини большой и указательный пальцы."
    : "Тренировка на паузе. Результаты сохранятся при продолжении.";
  const list = document.createElement("ul");
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
  metrics.textContent = `Активное время: ${(activeMs / 1000).toFixed(1)} с. Лучшее удержание: ${((session.exercises.hold.bestHoldMs ?? 0) / 1000).toFixed(1)} с.`;
  const prompts = document.createElement("p");
  prompts.textContent = (["pinch", "grip", "hold"] as const).map(id => `${labels[id]} — эпизоды подсказок: ${session.exercises[id].started ? Object.values(session.exercises[id].promptEpisodes).reduce((a, b) => a + b, 0) : "Не начато"}`).join(". ");
  const notice = document.createElement("p");
  notice.className = "results-note";
  notice.textContent = "Текущие результаты доступны до перезагрузки страницы.";
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
  container.append(notice, disclaimer);
  heading.focus();
}

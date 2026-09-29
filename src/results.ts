import type { Session } from "./session";
import type { ExerciseId } from "./types";

const labels: Record<ExerciseId, string> = { pinch: "Пинцет", grip: "Сжатия", hold: "Перенос" };

export function getResults(session: Session): { empty: boolean; rows: { exercise: ExerciseId; text: string }[] } {
  return {
    empty: Object.values(session.exercises).every(result => !result.started),
    rows: (["pinch", "grip", "hold"] as const).map(exercise => {
      const result = session.exercises[exercise];
      return { exercise, text: `${labels[exercise]}: ${result.started ? result.reps : "Не начато"}` };
    }),
  };
}

/** A snapshot of session data; never reads numbers back from the DOM. */
export function renderResults(container: HTMLElement, session: Session, onResume: () => void): void {
  const model = getResults(session);
  const heading = document.createElement("h2");
  heading.textContent = "Текущие итоги";
  heading.tabIndex = -1;
  const description = document.createElement("p");
  description.textContent = model.empty
    ? "Движений пока нет. Начни с пинцета: раскрой ладонь, затем соедини большой и указательный пальцы."
    : "Тренировка на паузе. Результаты сохранятся при продолжении.";
  const list = document.createElement("ul");
  for (const row of model.rows) {
    const item = document.createElement("li");
    item.textContent = row.text;
    list.append(item);
  }
  const resume = document.createElement("button");
  resume.id = "btn-resume";
  resume.textContent = model.empty ? "К упражнениям" : "Продолжить";
  resume.addEventListener("click", onResume);
  const notice = document.createElement("p");
  notice.className = "results-note";
  notice.textContent = "Текущие результаты доступны до перезагрузки страницы.";
  const disclaimer = document.createElement("p");
  disclaimer.className = "results-note";
  disclaimer.textContent = "Тренажёр не является медицинским устройством. Результаты описывают выполнение заданий.";
  container.replaceChildren(heading, description, list, resume, notice, disclaimer);
  heading.focus();
}

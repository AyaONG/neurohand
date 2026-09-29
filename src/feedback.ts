import type { ExerciseId, HandError, Phase } from "./types";

export const SUCCESS_COLOR_MS = 500;
export const SUCCESS_MESSAGE_MS = 900;
export type SuccessFeedback = { exercise: ExerciseId; reps: number; at: number };
export type Feedback = { text: string; success: boolean; error: boolean; celebrating: boolean };

export function getFeedback(input: {
  exercise: ExerciseId;
  timestampMs: number;
  visible: boolean;
  error: HandError | null;
  phase: Phase;
  success: SuccessFeedback | null;
  instruction: string;
  target?: number;
}): Feedback {
  if (!input.visible) return { text: "Рука не видна. Верни ладонь в кадр", success: false, error: false, celebrating: false };
  if (input.error) return {
    text: input.exercise === 'opposition' ? input.error.message : input.error.code === "WRONG_FINGER"
      ? "Соедини большой и указательный пальцы"
      : "Согни мизинец вместе с остальными пальцами",
    success: false, error: true, celebrating: false,
  };
  const age = input.success ? input.timestampMs - input.success.at : Infinity;
  if (input.success?.exercise === input.exercise && age >= 0 && age < SUCCESS_MESSAGE_MS) {
    const label = { pinch: "Захват засчитан", grip: "Сжатие засчитано", hold: "Цель засчитана", opposition: "Пара засчитана" }[input.exercise];
    return { text: `✓ ${label} · ${input.success.reps}${input.target ? ` из ${input.target}` : ""}`, success: age < SUCCESS_COLOR_MS, error: false, celebrating: true };
  }
  const next = input.phase === "CONFIRMED" && input.exercise !== "hold" && input.exercise !== "opposition"
    ? input.exercise === "pinch" ? "Разведи пальцы для следующего захвата" : "Раскрой кисть для следующего сжатия"
    : input.instruction;
  return { text: next, success: false, error: false, celebrating: false };
}

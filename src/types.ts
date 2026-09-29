export type Landmark = { x: number; y: number; z: number };
export type Point = { x: number; y: number };

export type BasicExerciseId = "pinch" | "grip" | "hold";
export type ExerciseId = BasicExerciseId | "opposition";
export type ErrorCode = "WRONG_FINGER" | "PINKY_INCOMPLETE" | "AMBIGUOUS_PAIR";

export type HandError = {
  code: ErrorCode;
  joints: number[];   // индексы landmarks, которые подсветить красным
  message: string;    // текст подсказки
};

// Единый выход валидатора для FSM и отрисовки
export type Reading = {
  open: boolean;
  closed: boolean;
  error: HandError | null;
};

export type Phase = "WAIT_OPEN" | "ARMED" | "CONFIRMED";
export type FsmState = { phase: Phase; reps: number; stable: number };

export type Calibration = { openCurl: number }; // средний curl при открытой ладони

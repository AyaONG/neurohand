import { HandGeometry } from "./HandGeometry.ts";
import type { HandGeometryOptions, HandLandmark } from "./HandGeometry.ts";

export type FistFingerTipIndex = 8 | 12 | 16 | 20;

export interface ExerciseValidatorOptions extends HandGeometryOptions {
  /** Порог в единицах getDistance(): по умолчанию 0.05 для normalized landmarks. */
  pinchThreshold?: number;
}

type SuccessResult = { status: "SUCCESS"; message: string };

export type PinchValidationResult =
  | SuccessResult
  | { status: "IN_PROGRESS"; message: string }
  | {
      status: "ERROR_WRONG_FINGER";
      message: string;
      fingerIndex: 12 | 16 | 20;
    };

export type FistValidationResult =
  | SuccessResult
  | {
      status: "ERROR_INCOMPLETE_FIST";
      message: string;
      extendedFingers: FistFingerTipIndex[];
    };

const FIST_FINGERS = [
  { tip: 8, mcp: 5, name: "указательный палец" },
  { tip: 12, mcp: 9, name: "средний палец" },
  { tip: 16, mcp: 13, name: "безымянный палец" },
  { tip: 20, mcp: 17, name: "мизинец" },
] as const;

const WRONG_PINCH_FINGERS = [
  { tip: 12, name: "средний палец" },
  { tip: 16, name: "безымянный палец" },
  { tip: 20, name: "мизинец" },
] as const;

/**
 * Проверяет один кадр; не хранит состояние и не зависит от UI.
 * Проверку координат и геометрические эвристики выполняет HandGeometry.
 */
export class ExerciseValidator {
  private readonly pinchThreshold: number;
  private readonly geometryOptions: HandGeometryOptions;

  constructor(options: ExerciseValidatorOptions = {}) {
    const { pinchThreshold = 0.05, ...geometryOptions } = options;
    if (!Number.isFinite(pinchThreshold) || pinchThreshold <= 0) {
      throw new RangeError("pinchThreshold должен быть конечным числом > 0.");
    }
    this.pinchThreshold = pinchThreshold;
    this.geometryOptions = geometryOptions;
  }

  validatePinch(landmarks: readonly HandLandmark[]): PinchValidationResult {
    const hand = new HandGeometry(landmarks, this.geometryOptions);

    // Правильный щипок имеет приоритет, даже если рядом есть другие пальцы.
    if (hand.getDistance(4, 8) < this.pinchThreshold) {
      return { status: "SUCCESS", message: "Щипок выполнен правильно" };
    }

    // Если несколько пальцев попали в порог, выбираем ближайший к большому.
    let wrongFinger: (typeof WRONG_PINCH_FINGERS)[number] | undefined;
    let closestDistance = this.pinchThreshold;
    for (const finger of WRONG_PINCH_FINGERS) {
      const distance = hand.getDistance(4, finger.tip);
      if (distance < closestDistance) {
        wrongFinger = finger;
        closestDistance = distance;
      }
    }

    if (wrongFinger) {
      return {
        status: "ERROR_WRONG_FINGER",
        fingerIndex: wrongFinger.tip,
        message: `Использован ${wrongFinger.name}. Соедините большой и указательный пальцы`,
      };
    }

    return {
      status: "IN_PROGRESS",
      message: "Соедините кончики большого и указательного пальцев",
    };
  }

  /**
   * Проверяет четыре пальца без большого — сценарий «три сжаты, один оттопырен».
   * Положение большого пальца не влияет на результат этого упражнения.
   */
  validateFist(landmarks: readonly HandLandmark[]): FistValidationResult {
    const hand = new HandGeometry(landmarks, this.geometryOptions);
    const extended = FIST_FINGERS.filter(
      ({ tip, mcp }) => !hand.isFingerFolded(tip, mcp),
    );

    if (extended.length === 0) {
      return { status: "SUCCESS", message: "Кулак сжат" };
    }

    // Подсказка также работает, если не сжато сразу несколько пальцев.
    return {
      status: "ERROR_INCOMPLETE_FIST",
      extendedFingers: extended.map(({ tip }) => tip),
      message: `Дожмите ${extended.map(({ name }) => name).join(", ")}`,
    };
  }
}

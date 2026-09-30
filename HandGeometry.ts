export interface HandLandmark {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type FingerTipIndex = 4 | 8 | 12 | 16 | 20;

export interface FistCompletion {
  /** Доля согнутых пальцев: 0, 20, 40, 60, 80 или 100. */
  percentage: number;
  /** Индексы кончиков пальцев, которые не признаны согнутыми. */
  extendedFingers: FingerTipIndex[];
}

export interface HandGeometryOptions {
  /** Порог distance(tip, wrist) / distance(mcp, wrist). */
  foldedRatio?: number;
  /** Порог distance(thumbTip, pinkyMcp) / ширина ладони. */
  thumbFoldedRatio?: number;
  /**
   * Для normalized landmarks: ширина кадра / высота кадра.
   * Для world landmarks оставьте 1. Приводит ось Y к масштабу X и Z.
   */
  aspectRatio?: number;
}

const FINGERS = [
  { tip: 4, mcp: 2 }, // Большой
  { tip: 8, mcp: 5 }, // Указательный
  { tip: 12, mcp: 9 }, // Средний
  { tip: 16, mcp: 13 }, // Безымянный
  { tip: 20, mcp: 17 }, // Мизинец
] as const;

/**
 * Геометрическая эвристика для одного кадра MediaPipe Hands.
 * Работает для обеих рук; пороги требуют настройки на целевых данных.
 * Создавайте новый экземпляр для каждого кадра.
 */
export class HandGeometry {
  private readonly landmarks: readonly HandLandmark[];
  private readonly foldedRatio: number;
  private readonly thumbFoldedRatio: number;
  private readonly aspectRatio: number;

  constructor(
    landmarks: readonly HandLandmark[],
    options: HandGeometryOptions = {},
  ) {
    if (landmarks.length !== 21) {
      throw new RangeError("Ожидается ровно 21 точка MediaPipe Hands.");
    }

    this.foldedRatio = options.foldedRatio ?? 1.1;
    this.thumbFoldedRatio = options.thumbFoldedRatio ?? 0.6;
    this.aspectRatio = options.aspectRatio ?? 1;

    for (const value of [this.foldedRatio, this.thumbFoldedRatio, this.aspectRatio]) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError("Пороги и aspectRatio должны быть конечными и > 0.");
      }
    }

    // Копия защищает результат от последующих изменений входного массива.
    this.landmarks = Array.from(landmarks, (point, index) => {
      if (!point || ![point.x, point.y, point.z].every(Number.isFinite)) {
        throw new TypeError(`Точка ${index} должна содержать конечные x, y, z.`);
      }
      return { x: point.x, y: point.y, z: point.z };
    });
  }

  /** Евклидово расстояние в 3D с учётом заданного масштаба Y. */
  getDistance(p1: number, p2: number): number {
    const a = this.getPoint(p1);
    const b = this.getPoint(p2);
    return Math.hypot(a.x - b.x, (a.y - b.y) / this.aspectRatio, a.z - b.z);
  }

  /** Принимает пары tip/MCP: 4/2, 8/5, 12/9, 16/13, 20/17. */
  isFingerFolded(tipIndex: number, mcpIndex: number): boolean {
    if (!FINGERS.some(({ tip, mcp }) => tip === tipIndex && mcp === mcpIndex)) {
      throw new RangeError("Некорректная пара индексов tip/MCP.");
    }

    // Большой палец движется поперёк ладони: проверяем близость к MCP мизинца.
    const isThumb = tipIndex === 4;
    const referenceDistance = isThumb
      ? this.getDistance(5, 17)
      : this.getDistance(mcpIndex, 0);

    if (referenceDistance === 0) {
      throw new RangeError("Вырожденные landmarks: размер ладони равен нулю.");
    }

    const tipDistance = this.getDistance(tipIndex, isThumb ? 17 : 0);
    const threshold = isThumb ? this.thumbFoldedRatio : this.foldedRatio;
    return tipDistance / referenceDistance <= threshold;
  }

  /** Это доля согнутых пальцев, а не непрерывная оценка угла или силы сжатия. */
  getFistCompletion(): FistCompletion {
    const extendedFingers: FingerTipIndex[] = [];

    for (const { tip, mcp } of FINGERS) {
      if (!this.isFingerFolded(tip, mcp)) extendedFingers.push(tip);
    }

    return {
      percentage: ((FINGERS.length - extendedFingers.length) / FINGERS.length) * 100,
      extendedFingers,
    };
  }

  private getPoint(index: number): HandLandmark {
    if (!Number.isInteger(index) || index < 0 || index >= 21) {
      throw new RangeError("Индекс точки должен быть целым числом от 0 до 20.");
    }
    return this.landmarks[index]!;
  }
}

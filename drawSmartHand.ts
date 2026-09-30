import type { HandLandmark } from "./HandGeometry.ts";

export type HandDrawStatus = "DEFAULT" | "SUCCESS" | "ERROR";

// Соединения MediaPipe Hands: пальцы и контур ладони.
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], // Большой
  [0, 5], [5, 6], [6, 7], [7, 8], // Указательный
  [5, 9], [9, 10], [10, 11], [11, 12], // Средний
  [9, 13], [13, 14], [14, 15], [15, 16], // Безымянный
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20], // Мизинец
] as const;

/**
 * Рисует руку по 21 normalized landmark (x/y обычно в диапазоне 0..1).
 * Z для 2D-отрисовки не используется. Пустой массив означает отсутствие руки.
 * Координаты привязаны к canvas.width/height; трансформация ctx временно сбрасывается.
 * Функция не очищает canvas. Очистку перед новым кадром выполняет вызывающий код.
 * errorJoints — индексы суставов 0..20, подсвечиваемые только в состоянии ERROR.
 */
export function drawSmartHand(
  ctx: CanvasRenderingContext2D,
  landmarks: readonly HandLandmark[],
  status: HandDrawStatus = "DEFAULT",
  errorJoints: readonly number[] = [],
): void {
  if (landmarks.length === 0) return;
  if (landmarks.length !== 21) {
    throw new RangeError("Ожидается ровно 21 точка MediaPipe Hands.");
  }
  if (status !== "DEFAULT" && status !== "SUCCESS" && status !== "ERROR") {
    throw new RangeError("Неизвестное состояние отрисовки руки.");
  }

  const { width, height } = ctx.canvas;
  const points = Array.from(landmarks, (point, index) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      throw new TypeError(`Точка ${index} должна содержать конечные x и y.`);
    }
    return { x: point.x * width, y: point.y * height };
  });
  const errors = new Set(errorJoints);
  for (const index of errors) {
    if (!Number.isInteger(index) || index < 0 || index >= 21) {
      throw new RangeError("Индекс ошибочного сустава должен быть от 0 до 20.");
    }
  }
  if (width === 0 || height === 0) return;

  const color = status === "SUCCESS" ? "#00E676" : "#87CEFA";

  ctx.save();
  try {
    // Рисуем в пикселях буфера, в том числе на canvas с повышенным разрешением.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.shadowColor = "transparent";
    ctx.setLineDash([]);
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = color;

    // Path2D сохраняет текущий путь вызывающего кода: save/restore его не сохраняют.
    const bones = new Path2D();
    for (const [from, to] of HAND_CONNECTIONS) {
      const a = points[from]!;
      const b = points[to]!;
      bones.moveTo(a.x, a.y);
      bones.lineTo(b.x, b.y);
    }
    ctx.stroke(bones);

    const drawJoint = (index: number, radius: number, fill: string): void => {
      const point = points[index]!;
      const circle = new Path2D();
      circle.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill(circle);
    };

    for (let index = 0; index < points.length; index++) {
      drawJoint(index, 5, color);
    }

    // Ошибочные суставы крупнее и рисуются последними, поверх голубой руки.
    if (status === "ERROR") {
      for (const index of errors) drawJoint(index, 8, "#FF5252");
    }
  } finally {
    ctx.restore();
  }
}

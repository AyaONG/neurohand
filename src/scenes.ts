import type { ExerciseId, Point } from "./types";

export const SCENES: Record<ExerciseId, { title: string; instruction: string }> = {
  pinch: { title: "Собери 5 огоньков", instruction: "Соедини большой и указательный пальцы. Разведи их перед следующим захватом." },
  grip: { title: "Сожми мягкий мяч", instruction: "Раскрой кисть, затем сожми пальцы — мяч станет меньше." },
  hold: { title: "Проведи свет в цель", instruction: "Перемести указатель открытой ладони в круг и удерживай 2 секунды." },
};
export type SparkFlight = { from: Point; at: number; action: number };
export function mirroredPinchPoint(points: Point[], width: number): Point {
  return { x: width - (points[4].x + points[8].x) / 2, y: (points[4].y + points[8].y) / 2 };
}
export type SceneInput = {
  exercise: ExerciseId;
  completed: number;
  timestampMs: number;
  reducedMotion: boolean;
  pinchPoint: Point | null;
  palm: Point | null;
  openPalm: boolean;
  openness: number | null;
  targets: (Point & { r: number })[];
  holdProgress: number;
  flight: SparkFlight | null;
};

const clamp = (v: number) => Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;

/** Presentation only: completed comes from confirmed session events, never landmarks. */
export function sceneModel(width: number, height: number, input: SceneInput) {
  const unit = Math.min(width, height);
  const total = input.exercise === "hold" ? 3 : 5;
  const completed = Math.max(0, Math.min(total, Math.trunc(input.completed)));
  const slots = Array.from({ length: total }, (_, i) => ({
    x: width / 2 + (i - (total - 1) / 2) * unit * 0.09,
    y: unit * 0.08, filled: i < completed,
  }));
  const age = input.flight ? input.timestampMs - input.flight.at : Infinity;
  let flying: Point | null = null;
  if (!input.reducedMotion && input.flight && input.flight.action === completed &&
      input.exercise === "pinch" && age >= 0 && age < 500 && completed > 0) {
    const progress = 1 - (1 - age / 500) ** 3;
    const to = slots[completed - 1];
    flying = { x: input.flight.from.x + (to.x - input.flight.from.x) * progress,
      y: input.flight.from.y + (to.y - input.flight.from.y) * progress };
  }
  const targets = input.targets.map((target, i) => ({
    ...target, completed: i < completed, active: i === completed,
    progress: i === completed ? clamp(input.holdProgress) : i < completed ? 1 : 0,
  }));
  const active = targets[completed];
  let arrow: { from: Point; to: Point } | null = null;
  if (input.exercise === "hold" && input.palm && active) {
    const dx = active.x - input.palm.x;
    const dy = active.y - input.palm.y;
    const distance = Math.hypot(dx, dy);
    if (distance > active.r + unit * 0.06) {
      const inset = unit * 0.04;
      arrow = {
        from: { x: input.palm.x + dx / distance * inset, y: input.palm.y + dy / distance * inset },
        to: { x: active.x - dx / distance * (active.r + inset), y: active.y - dy / distance * (active.r + inset) },
      };
    }
  }
  return {
    unit, slots, flying, targets, arrow,
    spark: completed < total && input.exercise === "pinch" && input.pinchPoint ? input.pinchPoint : null,
    ball: input.exercise === "grip" ? {
      x: width / 2, y: height * 0.52,
      r: unit * (0.065 + clamp(input.openness ?? 1) * 0.16), tracked: input.openness !== null,
    } : null,
    pointer: input.exercise === "hold" ? input.palm : null,
  };
}

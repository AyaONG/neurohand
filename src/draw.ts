import { HandLandmarker } from "@mediapipe/tasks-vision";
import type { Landmark, Point, Reading } from "./types";

export type DebugOptions = {
  enabled: boolean;
  fps: number;
  handSizeNorm: number | null;
  nullTimeoutMs: number;
  missingMs: number;
  gripOpenness?: number;
  target?: Point & { r: number; progress: number };
};

export function mirrorPoint(point: Point, width: number): Point {
  return { x: width - point.x, y: point.y };
}

export function drawHandOverlay(
  ctx: CanvasRenderingContext2D,
  landmarks: Landmark[] | null,
  reading: Reading | null,
  config: DebugOptions,
): void {
  const { width, height } = ctx.canvas;
  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.setLineDash([]);
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    if (config.gripOpenness !== undefined) {
      const ball = new Path2D();
      ball.arc(width / 2, height / 2, 30 + config.gripOpenness * 120, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(56,189,248,.18)";
      ctx.fill(ball);
      ctx.strokeStyle = "#38bdf8";
      ctx.stroke(ball);
    }
    if (config.target) {
      const { x, y, r, progress } = config.target;
      const circle = new Path2D();
      circle.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = "#38bdf8";
      ctx.stroke(circle);
      const arc = new Path2D();
      arc.arc(x, y, r + 10, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
      ctx.strokeStyle = "#22c55e";
      ctx.stroke(arc);
    }
    if (landmarks?.length === 21) {
      const pts = landmarks.map(p => mirrorPoint({ x: p.x * width, y: p.y * height }, width));
      const bones = new Path2D();
      for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
        bones.moveTo(pts[start].x, pts[start].y);
        bones.lineTo(pts[end].x, pts[end].y);
      }
      ctx.strokeStyle = "#38bdf8";
      ctx.stroke(bones);
      const errors = new Set(reading?.error?.joints ?? []);
      // Error joints are drawn last so adjacent normal points cannot cover them.
      for (const isError of [false, true]) {
        pts.forEach((p, i) => {
          if (errors.has(i) !== isError) return;
          const dot = new Path2D();
          dot.arc(p.x, p.y, isError ? 11 : 5, 0, Math.PI * 2);
          ctx.fillStyle = isError ? "#ef4444" : "#38bdf8";
          ctx.fill(dot);
        });
      }
    }
    if (config.enabled) {
      const lines = [
        `FPS: ${config.fps.toFixed(1)}`,
        `handSize: ${config.handSizeNorm?.toFixed(3) ?? "—"}`,
        `error: ${reading?.error?.code ?? "—"}`,
        `null: ${config.missingMs.toFixed(0)} / ${config.nullTimeoutMs} ms`,
      ];
      ctx.font = "20px monospace";
      const boxWidth = Math.max(...lines.map(line => ctx.measureText(line).width)) + 24;
      const left = Math.max(0, width - boxWidth - 12);
      ctx.fillStyle = "rgba(0,0,0,.65)";
      ctx.fillRect(left, 12, boxWidth, 112);
      ctx.fillStyle = "#e5e7eb";
      ctx.textBaseline = "top";
      lines.forEach((line, i) => ctx.fillText(line, left + 12, 22 + i * 24));
    }
  } finally {
    ctx.restore();
  }
}

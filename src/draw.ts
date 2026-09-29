import type { FingerTip } from './opposition';
import { HandLandmarker } from "@mediapipe/tasks-vision";
import type { Landmark, Point, Reading } from "./types";
import { sceneModel, type SceneInput } from "./scenes";

export type DebugOptions = {
  enabled: boolean;
  success?: boolean;
  fps: number;
  handSizeNorm: number | null;
  nullTimeoutMs: number;
  missingMs: number;
  gripOpenness?: number;
  target?: Point & { r: number; progress: number };
  scene?: SceneInput;
  pairTip?: FingerTip;
};

export function mirrorPoint(point: Point, width: number): Point {
  return { x: width - point.x, y: point.y };
}

function circle(ctx: CanvasRenderingContext2D, p: Point, r: number, fill: string, stroke?: string): void {
  const path = new Path2D();
  path.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill(path);
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(path); }
}

function spark(ctx: CanvasRenderingContext2D, p: Point, r: number, filled: boolean): void {
  if (filled) circle(ctx, p, r * 1.8, "rgba(251,191,36,.16)");
  const star = new Path2D();
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4 - Math.PI / 2;
    const radius = i % 2 ? r * 0.4 : r;
    const x = p.x + Math.cos(angle) * radius;
    const y = p.y + Math.sin(angle) * radius;
    if (i === 0) star.moveTo(x, y); else star.lineTo(x, y);
  }
  star.closePath();
  ctx.fillStyle = filled ? "#fbbf24" : "rgba(15,23,42,.6)";
  ctx.fill(star);
  ctx.strokeStyle = filled ? "#fef3c7" : "#94a3b8";
  ctx.stroke(star);
}

function drawScene(ctx: CanvasRenderingContext2D, input: SceneInput) {
  const model = sceneModel(ctx.canvas.width, ctx.canvas.height, input);
  const u = model.unit;
  ctx.lineWidth = Math.max(2, u * 0.005);
  if (input.exercise !== "hold") for (const slot of model.slots) {
    if (input.exercise === "pinch") spark(ctx, slot, u * 0.023, slot.filled);
    else {
      const segment = new Path2D();
      segment.rect(slot.x - u * 0.033, slot.y - u * 0.012, u * 0.066, u * 0.024);
      ctx.fillStyle = slot.filled ? "#22c55e" : "rgba(15,23,42,.7)";
      ctx.strokeStyle = slot.filled ? "#bbf7d0" : "#94a3b8";
      ctx.fill(segment); ctx.stroke(segment);
    }
  }
  if (model.ball) {
    const { x, y, r, tracked } = model.ball;
    const glow = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.05, x, y, r);
    glow.addColorStop(0, tracked ? "rgba(224,242,254,.65)" : "rgba(148,163,184,.3)");
    glow.addColorStop(1, tracked ? "rgba(14,165,233,.3)" : "rgba(71,85,105,.15)");
    const ball = new Path2D(); ball.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = glow; ctx.fill(ball);
    ctx.strokeStyle = tracked ? "#7dd3fc" : "#94a3b8"; ctx.stroke(ball);
    circle(ctx, { x: x - r * 0.3, y: y - r * 0.3 }, r * 0.17, "rgba(255,255,255,.25)");
  }
  if (input.exercise === "hold") {
    ctx.font = `${Math.max(16, u * 0.045)}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    model.targets.forEach((target, i) => {
      const color = target.completed ? "#22c55e" : target.active ? "#38bdf8" : "#94a3b8";
      ctx.setLineDash(target.active || target.completed ? [] : [u * 0.015, u * 0.015]);
      circle(ctx, target, target.r, target.active ? "rgba(56,189,248,.1)" : "rgba(15,23,42,.12)", color);
      ctx.setLineDash([]);
      if (target.progress > 0) {
        const arc = new Path2D();
        arc.arc(target.x, target.y, target.r + u * 0.014, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * target.progress);
        ctx.strokeStyle = "#22c55e"; ctx.lineWidth = u * 0.012; ctx.stroke(arc);
        ctx.lineWidth = Math.max(2, u * 0.005);
      }
      ctx.fillStyle = color;
      ctx.fillText(target.completed ? "✓" : `${i + 1}`, target.x, target.y);
    });
    if (model.arrow) {
      const { from, to } = model.arrow;
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const arrow = new Path2D(); arrow.moveTo(from.x, from.y); arrow.lineTo(to.x, to.y);
      for (const side of [-1, 1]) {
        arrow.moveTo(to.x, to.y);
        arrow.lineTo(to.x - Math.cos(angle + side * 0.5) * u * 0.03, to.y - Math.sin(angle + side * 0.5) * u * 0.03);
      }
      ctx.strokeStyle = "#fef3c7"; ctx.stroke(arrow);
    }
  }
  ctx.textAlign = "start";
  return model;
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
    const scene = config.scene ? drawScene(ctx, config.scene) : null;
    ctx.lineWidth = 6;
    if (!scene && config.gripOpenness !== undefined) {
      const ball = new Path2D();
      ball.arc(width / 2, height / 2, 30 + config.gripOpenness * 120, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(56,189,248,.18)";
      ctx.fill(ball);
      ctx.strokeStyle = "#38bdf8";
      ctx.stroke(ball);
    }
    if (!scene && config.target) {
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
      const handColor = config.success && !reading?.error ? "#22c55e" : "#38bdf8";
      const pts = landmarks.map(p => mirrorPoint({ x: p.x * width, y: p.y * height }, width));
      const bones = new Path2D();
      for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
        bones.moveTo(pts[start].x, pts[start].y);
        bones.lineTo(pts[end].x, pts[end].y);
      }
      ctx.strokeStyle = handColor;
      ctx.stroke(bones);
      if (config.pairTip) {
        for (const tip of [4, config.pairTip]) circle(ctx, pts[tip], Math.max(13, Math.min(width, height) * 0.025), 'rgba(251,191,36,.35)', '#fcd34d');
      }
      const errors = new Set(reading?.error?.joints ?? []);
      // Error joints are drawn last so adjacent normal points cannot cover them.
      for (const isError of [false, true]) {
        pts.forEach((p, i) => {
          if (errors.has(i) !== isError) return;
          const dot = new Path2D();
          dot.arc(p.x, p.y, isError ? 11 : 5, 0, Math.PI * 2);
          ctx.fillStyle = isError ? "#ef4444" : handColor;
          ctx.fill(dot);
        });
      }
    }
    if (scene && config.scene) {
      // Scene controls remain visible above the skeleton, without changing its coordinates.
      ctx.lineWidth = Math.max(2, scene.unit * 0.005);
      if (scene.spark && !reading?.error) spark(ctx, scene.spark, scene.unit * 0.018, true);
      if (scene.flying) spark(ctx, scene.flying, scene.unit * 0.025, true);
      if (scene.pointer) circle(ctx, scene.pointer, scene.unit * 0.022,
        config.scene.openPalm ? "#fbbf24" : "rgba(148,163,184,.5)", "#fff");
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

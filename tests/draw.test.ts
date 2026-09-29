import { afterEach, expect, it, vi } from "vitest";
import { drawHandOverlay } from "../src/draw";
import type { DebugOptions } from "../src/draw";

vi.mock("@mediapipe/tasks-vision", () => ({ HandLandmarker: { HAND_CONNECTIONS: [{ start: 0, end: 9 }] } }));

class Path {
  commands: (string | number)[][] = [];
  arc(...values: number[]) { this.commands.push(["arc", ...values]); }
  moveTo(...values: number[]) { this.commands.push(["moveTo", ...values]); }
  lineTo(...values: number[]) { this.commands.push(["lineTo", ...values]); }
  rect(...values: number[]) { this.commands.push(["rect", ...values]); }
  closePath() { this.commands.push(["closePath"]); }
}

function context() {
  const fills: { style: unknown; path: Path }[] = [];
  const strokes: { style: unknown; path: Path }[] = [];
  const ctx = {
    canvas: { width: 1280, height: 720 }, fillStyle: "", strokeStyle: "",
    save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), clearRect: vi.fn(), setLineDash: vi.fn(),
    fillRect: vi.fn(), fillText: vi.fn(), measureText: (text: string) => ({ width: text.length * 10 }),
    createRadialGradient: () => ({ addColorStop: vi.fn() }),
    fill(path: Path) { fills.push({ style: this.fillStyle, path }); },
    stroke(path: Path) { strokes.push({ style: this.strokeStyle, path }); },
  };
  return { ctx, fills, strokes };
}

const config: DebugOptions = { enabled: false, fps: 30, handSizeNorm: 0.2, nullTimeoutMs: 100, missingMs: 0 };
afterEach(() => vi.unstubAllGlobals());

it("draws mirrored landmarks, gives red error joints priority over success and restores canvas state", () => {
  vi.stubGlobal("Path2D", Path);
  const lm = Array.from({ length: 21 }, (_, i) => ({ x: 0.2 + i * 0.01, y: 0.5, z: 0 }));
  const { ctx, fills, strokes } = context();
  drawHandOverlay(ctx as unknown as CanvasRenderingContext2D, lm, {
    open: false, closed: false, error: { code: "WRONG_FINGER", joints: [12], message: "" },
  }, { ...config, success: true });
  expect(strokes[0].style).toBe("#38bdf8");
  expect(strokes[0].path.commands[0]).toEqual(["moveTo", 1280 - lm[0].x * 1280, 360]);
  expect(fills.filter(f => f.style === "#ef4444")).toHaveLength(1);
  expect(fills.at(-1)!.path.commands[0]).toEqual(["arc", 1280 - lm[12].x * 1280, 360, 11, 0, 2 * Math.PI]);
  expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, 1280, 720);
  expect(ctx.save).toHaveBeenCalledOnce();
  expect(ctx.restore).toHaveBeenCalledOnce();
  expect(ctx.fillText).not.toHaveBeenCalled();
});

it.each(["pinch", "grip", "hold"] as const)("renders the %s scene without a hand and without inventing a pointer", exercise => {
  vi.stubGlobal("Path2D", Path);
  const { ctx, fills } = context();
  drawHandOverlay(ctx as unknown as CanvasRenderingContext2D, null, null, { ...config, scene: {
    exercise, completed: 0, timestampMs: 1000, reducedMotion: true,
    pinchPoint: null, palm: null, openPalm: false, openness: null, flight: null,
    targets: [{ x: 448, y: 360, r: 86 }], holdProgress: 0,
  } });
  expect(fills.length).toBeGreaterThan(0);
  expect(fills.some(fill => fill.style === "#ef4444")).toBe(false);
  expect(ctx.restore).toHaveBeenCalledOnce();
});

it('highlights exactly the thumb and chosen tip at mirrored video coordinates', () => {
  vi.stubGlobal('Path2D', Path);
  const lm = Array.from({ length: 21 }, (_, i) => ({ x: 0.2 + i * 0.01, y: 0.5, z: 0 }));
  const { ctx, fills } = context();
  drawHandOverlay(ctx as unknown as CanvasRenderingContext2D, lm, null, { ...config, pairTip: 16 });
  const highlighted = fills.filter(fill => fill.style === 'rgba(251,191,36,.35)');
  expect(highlighted).toHaveLength(2);
  expect(highlighted.map(fill => fill.path.commands[0].slice(1, 3))).toEqual([4, 16].map(t => [1280 - lm[t].x * 1280, 360]));
});

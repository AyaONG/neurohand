// Точка входа NeuroHand: связывает модули, цикл кадров и интерфейс.
import { initCamera, initTracker } from "./camera";
import { DEFAULT_CONFIG, HandGeometry } from "./geometry";
import { calibrate, gripOpenness, readGrip, stepPinchTracking, type PinchTrackingState } from "./validator";
import { createTarget, HOLD_TARGET_MS, initialFsm, step, stepHold, type HoldState, type Target } from "./fsm";
import { drawHandOverlay, mirrorPoint } from "./draw";
import { dumpCapture, updateDebug, type Capture } from "./debug";
import type { Calibration, ExerciseId, FsmState, Reading } from "./types";

const video = document.querySelector<HTMLVideoElement>("#video")!;
const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
const ctx = canvas.getContext("2d")!;
const stage = document.querySelector<HTMLElement>("#stage")!;
const hint = document.querySelector<HTMLElement>("#hint")!;
const score = document.querySelector<HTMLElement>("#score")!;
const debug = document.querySelector<HTMLElement>("#debug")!;
const start = document.querySelector<HTMLButtonElement>("#btn-start")!;
const calibrateButton = document.querySelector<HTMLButtonElement>("#btn-calibrate")!;
const dump = document.querySelector<HTMLButtonElement>("#btn-dump")!;
const tabs = document.querySelector<HTMLElement>("#tabs")!;
const labels: Record<ExerciseId, string> = { pinch: "Пинцет", grip: "Эспандер", hold: "Перенос" };

let mode: ExerciseId = "pinch";
let tracker: Awaited<ReturnType<typeof initTracker>> | null = null;
let stream: MediaStream | null = null;
let running = false;
let generation = 0;
let requestId = 0;
let lastVideoTime = -1;
let lastFrameTimestamp: number | null = null;
let fps = 0;
let debugEnabled = true;
let fsm: FsmState = { ...initialFsm };
let hold: HoldState = { holdMs: 0, reps: 0 };
let target: Target | null = null;
let lastHoldTimestamp: number | null = null;
let tracking: PinchTrackingState = { previousWrongJoint: null, lastValidTimestamp: null };
let cal: Calibration | null = null;
let calibrationStart: number | null = null;
let calibrationSamples: HandGeometry[] = [];
let capture: Capture | null = null;

function setHint(message: string, error = false): void {
  hint.textContent = message;
  for (const element of [hint, score, debug]) element.classList.toggle("error", error);
}

function resetTracking(): void {
  tracking = { previousWrongJoint: null, lastValidTimestamp: null };
  lastHoldTimestamp = null;
  capture = null;
  dump.disabled = true;
}

function stopCamera(): void {
  generation++;
  running = false;
  cancelAnimationFrame(requestId);
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  tracker?.close();
  tracker = null;
  start.disabled = false;
  calibrateButton.disabled = true;
  calibrationStart = null;
  calibrationSamples = [];
  lastFrameTimestamp = null;
  lastVideoTime = -1;
  fps = 0;
  fsm = { ...fsm, phase: "WAIT_OPEN", stable: 0 };
  hold = { ...hold, holdMs: 0 };
  resetTracking();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function cameraError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Доступ к камере запрещён. Разрешите доступ в браузере и нажмите «Включить камеру».";
  if (name === "NotFoundError") return "Камера не найдена. Подключите камеру и повторите.";
  if (name === "NotReadableError") return "Камера недоступна. Закройте другие приложения, использующие камеру.";
  return "Не удалось запустить камеру или трекер. Проверьте локальные /wasm и /models/hand_landmarker.task и повторите.";
}

function processFrame(timestampMs: number): void {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    if (width > 0 && height > 0) stage.style.aspectRatio = `${width} / ${height}`;
    target = width > 0 && height > 0 ? createTarget(width, height) : null;
    hold = { ...hold, holdMs: 0 };
    lastHoldTimestamp = null;
  }
  const hasNewFrame = width > 0 && height > 0 && video.readyState >= 2 && video.currentTime !== lastVideoTime;
  let landmarks = null;
  if (hasNewFrame) {
    lastVideoTime = video.currentTime;
    landmarks = tracker!.detectForVideo(video, timestampMs).landmarks[0] ?? null;
    fps = lastFrameTimestamp === null ? 0 : 1000 / (timestampMs - lastFrameTimestamp);
    lastFrameTimestamp = timestampMs;
  } else if (lastFrameTimestamp !== null && timestampMs - lastFrameTimestamp <= DEFAULT_CONFIG.NULL_TIMEOUT_MS) {
    return; // Do not count the same video frame twice.
  } else {
    fps = 0;
  }
  const g = landmarks ? HandGeometry.create(landmarks, width, height) : null;
  const tracked = stepPinchTracking(tracking, g, timestampMs);
  tracking = tracked.state;
  let reading: Reading | null = null;
  let message = g ? "" : landmarks ? "Поднесите руку ближе к камере" : "Рука не видна";
  const isCalibrating = calibrationStart !== null;
  if (calibrationStart !== null) {
    if (g && hasNewFrame) calibrationSamples.push(g);
    message = "Раскройте ладонь и держите 2 секунды";
    if (timestampMs - calibrationStart >= 2000) {
      if (calibrationSamples.length >= 20) {
        cal = calibrate(calibrationSamples);
        message = "Откалибровано";
      } else message = "Рука не видна, повторите";
      calibrationStart = null;
      calibrationSamples = [];
      calibrateButton.disabled = false;
    }
  }
  if (!isCalibrating) {
    if (mode === "pinch") {
      reading = tracked.reading;
      fsm = step(fsm, reading);
      if (g) message = "Соедините большой и указательный пальцы, затем раскройте ладонь";
    } else if (mode === "grip") {
      reading = g && cal ? readGrip(g, cal, timestampMs) : null;
      fsm = step(fsm, reading);
      if (!cal) message = "Нажмите «Калибровка»";
      else if (g) message = "Сожмите кулак, затем раскройте ладонь";
    } else if (target) {
      const palm = g ? mirrorPoint(g.palmCenter(), width) : null;
      const dt = lastHoldTimestamp === null ? 0 : timestampMs - lastHoldTimestamp;
      const before = hold.reps;
      hold = stepHold(hold, palm, target, dt > DEFAULT_CONFIG.NULL_TIMEOUT_MS ? 0 : dt);
      lastHoldTimestamp = g ? timestampMs : null;
      if (hold.reps > before) target = createTarget(width, height);
      reading = g ? { open: false, closed: hold.holdMs > 0 || hold.reps > before, error: null } : null;
      if (g) message = "Удерживайте центр ладони в круге 2 секунды";
    }
  }
  setHint(reading?.error?.message ?? message, !!reading?.error);
  score.textContent = `${labels[mode]}: ${mode === "hold" ? hold.reps : fsm.reps}`;
  const missingMs = g || tracking.lastValidTimestamp === null ? 0 : timestampMs - tracking.lastValidTimestamp;
  drawHandOverlay(ctx, g ? landmarks : null, reading, {
    enabled: debugEnabled, fps, handSizeNorm: g?.handSizeNorm ?? null,
    nullTimeoutMs: DEFAULT_CONFIG.NULL_TIMEOUT_MS, missingMs,
    gripOpenness: mode === "grip" && g && cal ? gripOpenness(g, cal) : undefined,
    target: mode === "hold" && target ? { ...target, progress: hold.holdMs / HOLD_TARGET_MS } : undefined,
  });
  updateDebug(debug, g, fps, {
    phase: mode === "hold" ? "HOLD" : fsm.phase,
    error: reading?.error?.code ?? null,
    previousWrongJoint: tracking.previousWrongJoint,
    missingMs, timeoutMs: DEFAULT_CONFIG.NULL_TIMEOUT_MS,
    width, height,
  });
  capture = g && landmarks && reading ? {
    timestamp: timestampMs, exercise: mode,
    landmarks: landmarks.map(p => ({ x: p.x, y: p.y, z: p.z })),
    expectedReading: reading,
  } : null;
  dump.disabled = capture === null;
}

function loop(timestampMs: number): void {
  if (!running) return;
  try {
    processFrame(timestampMs);
  } catch {
    stopCamera();
    setHint("Ошибка обработки кадра. Нажмите «Включить камеру», чтобы повторить.", true);
    return;
  }
  requestId = requestAnimationFrame(loop);
}

start.addEventListener("click", async () => {
  if (running || start.disabled) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    setHint("Камера доступна только через HTTPS или localhost в поддерживаемом браузере.", true);
    return;
  }
  const token = ++generation;
  start.disabled = true;
  setHint("Запуск камеры и загрузка локальной модели…");
  try {
    const newStream = await initCamera(video);
    if (token !== generation) { newStream.getTracks().forEach(track => track.stop()); return; }
    stream = newStream;
    const newTracker = await initTracker();
    if (token !== generation) { newTracker.close(); return; }
    tracker = newTracker;
    running = true;
    calibrateButton.disabled = false;
    for (const track of stream.getTracks()) track.addEventListener("ended", () => {
      if (!running) return;
      stopCamera();
      setHint("Камера отключена. Подключите её и повторите запуск.", true);
    });
    requestId = requestAnimationFrame(loop);
  } catch (error) {
    if (token !== generation) return;
    stopCamera();
    setHint(cameraError(error), true);
  }
});

tabs.addEventListener("click", event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
  const selected = button?.dataset.mode;
  if (selected !== "pinch" && selected !== "grip" && selected !== "hold") return;
  mode = selected;
  fsm = { ...initialFsm };
  hold = { holdMs: 0, reps: 0 };
  resetTracking();
  tabs.querySelectorAll("[data-mode]").forEach(tab => tab.classList.toggle("active", tab === button));
  score.textContent = `${labels[mode]}: 0`;
  setHint(running ? "Покажите ладонь камере" : "Нажмите «Включить камеру»");
});

calibrateButton.addEventListener("click", () => {
  if (!running || calibrationStart !== null) return;
  calibrationStart = performance.now();
  calibrationSamples = [];
  calibrateButton.disabled = true;
  fsm = { ...fsm, phase: "WAIT_OPEN", stable: 0 };
  hold = { ...hold, holdMs: 0 };
  resetTracking();
});

dump.addEventListener("click", () => {
  if (capture) dumpCapture(capture);
});
document.addEventListener("keydown", event => {
  if (event.code !== "KeyD" || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  debugEnabled = !debugEnabled;
  debug.hidden = !debugEnabled;
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && (running || start.disabled)) {
    stopCamera();
    setHint("Камера остановлена. Нажмите «Включить камеру» для продолжения.");
  }
});
window.addEventListener("pagehide", stopCamera);
if (import.meta.hot) import.meta.hot.dispose(stopCamera);
debug.hidden = false;
dump.disabled = true;
score.textContent = "Пинцет: 0";
setHint("Нажмите «Включить камеру»");

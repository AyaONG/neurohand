// Точка входа NeuroHand: связывает модули, цикл кадров и интерфейс.
import { initCamera, initTracker } from "./camera";
import { DEFAULT_CONFIG, HandGeometry } from "./geometry";
import { calibrate, gripOpenness, readGrip, stepPinchTracking, type PinchTrackingState } from "./validator";
import { createTarget, HOLD_TARGET_MS, initialFsm, step, stepHold, type HoldState, type Target } from "./fsm";
import { drawHandOverlay, mirrorPoint } from "./draw";
import { dumpCapture, updateDebug, type Capture } from "./debug";
import { createSession, pauseSession, recordRep, resumeSession, startExercise } from "./session";
import { getFeedback, type SuccessFeedback } from "./feedback";
import { renderResults } from "./results";
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
const panel = document.querySelector<HTMLElement>("#panel")!;
const results = document.querySelector<HTMLElement>("#results")!;
const resultsButton = document.querySelector<HTMLButtonElement>("#btn-results")!;
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
let debugEnabled = new URLSearchParams(location.search).get("debug") === "1";
let session = createSession();
let successFeedback: SuccessFeedback | null = null;
let fsm: FsmState = { ...initialFsm };
let hold: HoldState = { holdMs: 0, reps: 0 };
let target: Target | null = null;
let lastHoldTimestamp: number | null = null;
let tracking: PinchTrackingState = { previousWrongJoint: null, lastValidTimestamp: null };
let cal: Calibration | null = null;
let calibrationStart: number | null = null;
let calibrationSamples: HandGeometry[] = [];
let capture: Capture | null = null;

function setHint(message: string, error = false, celebrating = false): void {
  // aria-live should announce changed states, not each camera frame.
  if (hint.textContent !== message) hint.textContent = message;
  hint.classList.toggle("error", error);
  hint.classList.toggle("success", celebrating);
}

function updateScore(): void {
  const text = `${labels[mode]}: ${session.exercises[mode].reps}`;
  if (score.textContent !== text) score.textContent = text;
}

function resetTracking(): void {
  tracking = { previousWrongJoint: null, lastValidTimestamp: null };
  lastHoldTimestamp = null;
  capture = null;
  dump.disabled = true;
  successFeedback = null;
}

function resetExerciseState(): void {
  fsm = { ...initialFsm, reps: session.exercises[mode].reps };
  hold = { holdMs: 0, reps: session.exercises.hold.reps };
  lastFrameTimestamp = null;
  lastVideoTime = -1;
  calibrationStart = null;
  calibrationSamples = [];
  calibrateButton.disabled = !running;
  resetTracking();
}

function resumeExercise(): void {
  session = resumeSession(session);
  resetExerciseState();
  results.hidden = true;
  stage.hidden = false;
  panel.hidden = false;
  tabs.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach(button => { button.disabled = false; });
  resultsButton.setAttribute("aria-expanded", "false");
  resultsButton.textContent = "Итоги";
  updateScore();
  setHint(running ? "Раскрой ладонь перед следующим движением" : "Нажмите «Включить камеру»");
  tabs.querySelector<HTMLButtonElement>(`[data-mode="${mode}"]`)?.focus();
}

function showResults(): void {
  session = pauseSession(session);
  resetExerciseState();
  stage.hidden = true;
  panel.hidden = true;
  results.hidden = false;
  tabs.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach(button => { button.disabled = true; });
  resultsButton.setAttribute("aria-expanded", "true");
  resultsButton.textContent = "К упражнениям";
  renderResults(results, session, resumeExercise);
}

function setDebugVisibility(): void {
  debug.hidden = !debugEnabled;
  dump.hidden = !debugEnabled;
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
  // Results are a paused snapshot: no detection, timers, or counting behind it.
  if (session.paused) return;
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
  if (reading && g && !isCalibrating) {
    session = startExercise(session, mode);
    const action = mode === "hold" ? hold.reps : fsm.reps;
    const next = recordRep(session, { sessionId: session.id, exercise: mode, action });
    if (next !== session) successFeedback = { exercise: mode, reps: action, at: timestampMs };
    session = next;
  }
  // A new error/lost hand cancels the old celebration instead of replaying it.
  if (!g || reading?.error) successFeedback = null;
  const feedback = getFeedback({
    exercise: mode, timestampMs, visible: !!g, error: reading?.error ?? null,
    phase: fsm.phase, success: successFeedback, instruction: message,
  });
  setHint(feedback.text, feedback.error, feedback.celebrating);
  updateScore();
  const missingMs = g || tracking.lastValidTimestamp === null ? 0 : timestampMs - tracking.lastValidTimestamp;
  drawHandOverlay(ctx, g ? landmarks : null, reading, {
    enabled: debugEnabled, success: feedback.success, fps, handSizeNorm: g?.handSizeNorm ?? null,
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
  if (running || start.disabled || session.paused) return;
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
  if (session.paused) return;
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
  const selected = button?.dataset.mode;
  if (selected !== "pinch" && selected !== "grip" && selected !== "hold") return;
  mode = selected;
  resetExerciseState();
  tabs.querySelectorAll("[data-mode]").forEach(tab => tab.classList.toggle("active", tab === button));
  updateScore();
  setHint(running ? "Покажите ладонь камере" : "Нажмите «Включить камеру»");
});

calibrateButton.addEventListener("click", () => {
  if (!running || calibrationStart !== null || session.paused) return;
  calibrationStart = performance.now();
  calibrationSamples = [];
  calibrateButton.disabled = true;
  fsm = { ...fsm, phase: "WAIT_OPEN", stable: 0 };
  hold = { ...hold, holdMs: 0 };
  resetTracking();
});

dump.addEventListener("click", () => {
  if (debugEnabled && capture && !session.paused) dumpCapture(capture);
});
resultsButton.addEventListener("click", () => {
  if (results.hidden) showResults();
  else resumeExercise();
});
document.addEventListener("keydown", event => {
  if (event.code !== "KeyD" || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  debugEnabled = !debugEnabled;
  setDebugVisibility();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && (running || start.disabled)) {
    stopCamera();
    setHint("Камера остановлена. Нажмите «Включить камеру» для продолжения.");
  }
});
window.addEventListener("pagehide", stopCamera);
if (import.meta.hot) import.meta.hot.dispose(stopCamera);
setDebugVisibility();
dump.disabled = true;
updateScore();
setHint("Нажмите «Включить камеру»");

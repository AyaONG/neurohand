// Точка входа NeuroHand: связывает модули, цикл кадров и интерфейс.
import { initCamera, initTracker } from "./camera";
import { DEFAULT_CONFIG, HandGeometry } from "./geometry";
import { gripOpenness, stepPinchTracking, type PinchTrackingState } from "./validator";
import { HOLD_TARGET_MS } from "./fsm";
import { beginProgram, createProgram, EXERCISES, guidedTarget, pauseProgram, programInstruction, stepProgram, stopProgram } from "./program";
import { drawHandOverlay, mirrorPoint } from "./draw";
import { dumpCapture, updateDebug, type Capture } from "./debug";
import type { Session } from "./session";
import { getFeedback } from "./feedback";
import { renderResults } from "./results";
import type { ExerciseId } from "./types";

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
const pauseButton = document.querySelector<HTMLButtonElement>("#btn-pause")!;
const handChoice = document.querySelector<HTMLSelectElement>("#hand-choice")!;
const programStatus = document.querySelector<HTMLElement>("#program-status")!;
const labels: Record<ExerciseId, string> = { pinch: "Пинцет", grip: "Эспандер", hold: "Перенос" };

let mode: ExerciseId = "pinch";
let program = createProgram();
// Final snapshots survive a new session in memory; persistence is stage 4.
const finalizedSessions: Session[] = [];
let tracker: Awaited<ReturnType<typeof initTracker>> | null = null;
let stream: MediaStream | null = null;
let running = false;
let starting = false;
let generation = 0;
let requestId = 0;
let lastVideoTime = -1;
let lastFrameTimestamp: number | null = null;
let fps = 0;
let debugEnabled = new URLSearchParams(location.search).get("debug") === "1";
let tracking: PinchTrackingState = { previousWrongJoint: null, lastValidTimestamp: null };
let capture: Capture | null = null;

function setHint(message: string, error = false, celebrating = false): void {
  // aria-live should announce changed states, not each camera frame.
  if (hint.textContent !== message) hint.textContent = message;
  hint.classList.toggle("error", error);
  hint.classList.toggle("success", celebrating);
}

function updateScore(): void {
  const text = `${labels[mode]}: ${program.session.exercises[mode].reps} / ${program.session.exercises[mode].target}`;
  if (score.textContent !== text) score.textContent = text;
}

function resetTracking(): void {
  tracking = { previousWrongJoint: null, lastValidTimestamp: null };
  capture = null;
  dump.disabled = true;
}

function resetFrameClock(): void {
  lastFrameTimestamp = null;
  lastVideoTime = -1;
  resetTracking();
}

function showExercise(): void {
  results.hidden = true;
  stage.hidden = false;
  panel.hidden = false;
  resultsButton.setAttribute("aria-expanded", "false");
  resultsButton.textContent = "Итоги";
}

function resumeExercise(): void {
  if (program.session.status !== "in_progress") return;
  showExercise();
  resetFrameClock();
  if (program.phase !== "intro") program = beginProgram(program);
  pauseButton.textContent = "Пауза";
  if (!running) start.disabled = starting;
  setHint(running ? "Раскрой ладонь перед продолжением" : "Нажми «Начать тренировку»");
}

function rememberFinal(): void {
  if (program.session.status !== "in_progress" && !finalizedSessions.some(s => s.id === program.session.id)) {
    finalizedSessions.push(program.session);
  }
}

function newTraining(): void {
  stopCamera();
  rememberFinal();
  program = createProgram();
  mode = "pinch";
  handChoice.disabled = false;
  showExercise();
  updateScore();
  programStatus.textContent = "5 пинцетов → 5 сжатий → 3 цели по 2 секунды";
  start.textContent = "Начать тренировку";
  pauseButton.disabled = true;
  setHint("Выбери руку и нажми «Начать тренировку»");
}

function finishTraining(): void {
  program = stopProgram(program, new Date().toISOString());
  rememberFinal();
  stopCamera();
  showResults();
}

function showResults(): void {
  if (program.session.status === "in_progress") program = pauseProgram(program, "results");
  resetFrameClock();
  stage.hidden = true;
  panel.hidden = true;
  results.hidden = false;
  resultsButton.setAttribute("aria-expanded", "true");
  resultsButton.textContent = program.session.status === "in_progress" ? "К упражнениям" : "Итоги";
  renderResults(results, program.session, resumeExercise, finishTraining, newTraining);
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
  start.disabled = starting;
  calibrateButton.disabled = true;
  pauseButton.disabled = true;
  lastFrameTimestamp = null;
  lastVideoTime = -1;
  fps = 0;
  resetTracking();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function cameraError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Доступ к камере запрещён. Разрешите доступ в браузере и нажмите «Начать тренировку».";
  if (name === "NotFoundError") return "Камера не найдена. Подключите камеру и повторите.";
  if (name === "NotReadableError") return "Камера недоступна. Закройте другие приложения, использующие камеру.";
  return "Не удалось запустить камеру или трекер. Проверьте локальные /wasm и /models/hand_landmarker.task и повторите.";
}

function processFrame(timestampMs: number): void {
  if (program.phase === "summary" || (program.phase === "paused" && program.pauseReason !== "tracking")) return;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    if (width > 0 && height > 0) stage.style.aspectRatio = `${width} / ${height}`;
    // A changed scene invalidates partial holds and requires readiness again.
    if (program.phase === "exercise") program = beginProgram(program);
    resetFrameClock();
  }
  const hasNewFrame = width > 0 && height > 0 && video.readyState >= 2 && video.currentTime !== lastVideoTime;
  let landmarks = null;
  if (hasNewFrame) {
    lastVideoTime = video.currentTime;
    landmarks = tracker!.detectForVideo(video, timestampMs).landmarks[0] ?? null;
    fps = lastFrameTimestamp === null ? 0 : 1000 / (timestampMs - lastFrameTimestamp);
    lastFrameTimestamp = timestampMs;
  } else if (lastFrameTimestamp !== null && timestampMs - lastFrameTimestamp <= DEFAULT_CONFIG.NULL_TIMEOUT_MS) {
    return;
  } else fps = 0;
  const fullHand = !!landmarks && landmarks.every(p => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
  const g = landmarks && fullHand ? HandGeometry.create(landmarks, width, height) : null;
  const tracked = stepPinchTracking(tracking, g, timestampMs);
  tracking = tracked.state;
  const target = width > 0 && height > 0 ? guidedTarget(width, height, program.session.exercises.hold.reps) : null;
  program = stepProgram(program, {
    timestampMs, wallTime: new Date().toISOString(), geometry: g, fullHand,
    pinch: tracked.reading, palm: g ? mirrorPoint(g.palmCenter(), width) : null, target,
  });
  mode = program.session.currentExercise;
  if (program.phase === "summary") {
    rememberFinal();
    stopCamera();
    showResults();
    return;
  }
  const reading = program.reading;
  const instruction = programInstruction(program, timestampMs);
  const feedback = getFeedback({
    exercise: mode, timestampMs, visible: !!g, error: reading?.error ?? null,
    phase: program.fsm.phase, success: program.success, instruction,
    target: program.session.exercises[mode].target,
  });
  if (program.phase === "paused") setHint(instruction);
  else if (g && (program.phase === "preparing" || program.phase === "transition")) setHint(instruction);
  else setHint(feedback.text, feedback.error, feedback.celebrating);
  updateScore();
  programStatus.textContent = `Задание ${EXERCISES.indexOf(mode) + 1} из 3 · ${labels[mode]}`;
  tabs.querySelectorAll<HTMLElement>("[data-mode]").forEach(tab => tab.classList.toggle("active", tab.dataset.mode === mode));
  pauseButton.disabled = false;
  const missingMs = g || tracking.lastValidTimestamp === null ? 0 : timestampMs - tracking.lastValidTimestamp;
  const nextTarget = width > 0 && height > 0 ? guidedTarget(width, height, program.session.exercises.hold.reps) : null;
  drawHandOverlay(ctx, g ? landmarks : null, reading, {
    enabled: debugEnabled, success: feedback.success, fps, handSizeNorm: g?.handSizeNorm ?? null,
    nullTimeoutMs: DEFAULT_CONFIG.NULL_TIMEOUT_MS, missingMs,
    gripOpenness: mode === "grip" && g && program.calibration ? gripOpenness(g, program.calibration) : undefined,
    target: mode === "hold" && nextTarget ? { ...nextTarget, progress: program.hold.holdMs / HOLD_TARGET_MS } : undefined,
  });
  updateDebug(debug, g, fps, {
    program: program.phase, phase: program.fsm.phase, error: reading?.error?.code ?? null,
    previousWrongJoint: tracking.previousWrongJoint, missingMs, timeoutMs: DEFAULT_CONFIG.NULL_TIMEOUT_MS, width, height,
  });
  capture = g && landmarks && reading ? {
    timestamp: timestampMs, exercise: mode,
    landmarks: landmarks.map(p => ({ x: p.x, y: p.y, z: p.z })), expectedReading: reading,
  } : null;
  dump.disabled = capture === null;
}

function loop(timestampMs: number): void {
  if (!running) return;
  try {
    processFrame(timestampMs);
  } catch {
    program = pauseProgram(program, "camera");
    stopCamera();
    setHint("Ошибка обработки кадра. Нажмите «Начать тренировку», чтобы повторить.", true);
    return;
  }
  if (running) requestId = requestAnimationFrame(loop);
}

start.addEventListener("click", async () => {
  if (running || starting || start.disabled || program.session.status !== "in_progress") return;
  program = beginProgram(program);
  const hand = handChoice.value;
  if (!Object.values(program.session.exercises).some(result => result.started)) {
    program = { ...program, session: { ...program.session, hand: hand === "left" || hand === "right" ? hand : "unspecified" } };
  }
  handChoice.disabled = true;
  showExercise();
  if (!navigator.mediaDevices?.getUserMedia) {
    setHint("Камера доступна только через HTTPS или localhost в поддерживаемом браузере.", true);
    return;
  }
  const token = ++generation;
  starting = true;
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
    calibrateButton.disabled = true;
    pauseButton.disabled = false;
    for (const track of stream.getTracks()) track.addEventListener("ended", () => {
      if (!running) return;
      program = pauseProgram(program, "camera");
      stopCamera();
      setHint("Камера отключена. Подключите её и повторите запуск.", true);
    });
    requestId = requestAnimationFrame(loop);
  } catch (error) {
    if (token !== generation) return;
    program = pauseProgram(program, "camera");
    stopCamera();
    setHint(cameraError(error), true);
  } finally {
    starting = false;
    start.disabled = running;
  }
});

// Guided order replaces manual mode switching; the three labels show progress.
tabs.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach(button => { button.disabled = true; });
calibrateButton.hidden = true;
pauseButton.addEventListener("click", () => {
  if (program.phase === "paused" && program.pauseReason !== "tracking") {
    program = beginProgram(program);
    resetFrameClock();
    pauseButton.textContent = "Пауза";
    setHint("Раскрой ладонь перед продолжением");
  } else {
    program = pauseProgram(program, "manual");
    resetFrameClock();
    pauseButton.textContent = "Продолжить";
    setHint("Тренировка на паузе. Нажми «Продолжить»");
  }
});

dump.addEventListener("click", () => {
  if (debugEnabled && capture && program.phase === "exercise") dumpCapture(capture);
});
resultsButton.addEventListener("click", () => {
  if (results.hidden) showResults();
  else if (program.session.status === "in_progress") resumeExercise();
});
document.addEventListener("keydown", event => {
  if (event.code !== "KeyD" || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  debugEnabled = !debugEnabled;
  setDebugVisibility();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden && (running || start.disabled)) {
    program = pauseProgram(program, "visibility");
    stopCamera();
    setHint("Камера остановлена. Нажмите «Начать тренировку» для продолжения.");
  }
});
window.addEventListener("pagehide", stopCamera);
if (import.meta.hot) import.meta.hot.dispose(stopCamera);
setDebugVisibility();
dump.disabled = true;
updateScore();
setHint("Выбери руку и нажми «Начать тренировку»");

import { createOppositionSession } from './session';
import { currentPair, FINGER_TIPS, FINGER_NAMES, pairCounts, pairTask } from './opposition';
import { finishOppositionAttempt, skipOppositionPair } from './opposition-program';
// Точка входа NeuroHand: связывает модули, цикл кадров и интерфейс.
import { initCamera, initTracker } from "./camera";
import { DEFAULT_CONFIG, HandGeometry } from "./geometry";
import { gripOpenness, stepPinchTracking, type PinchTrackingState } from "./validator";
import { HOLD_TARGET_MS } from "./fsm";
import { beginProgram, createProgram, EXERCISES, guidedTarget, pauseProgram, programInstruction, stepProgram, stopProgram } from "./program";
import { drawHandOverlay, mirrorPoint } from "./draw";
import { SCENES, mirroredPinchPoint, type SparkFlight } from "./scenes";
import { dumpCapture, updateDebug, type Capture } from "./debug";
import { ProgressStore } from "./storage";
import { renderHistory } from "./history";
import { spokenHint } from "./presentation";
import { getFeedback } from "./feedback";
import { renderResults } from "./results";
import type { BasicExerciseId, ExerciseId } from "./types";

const video = document.querySelector<HTMLVideoElement>("#video")!;
const canvas = document.querySelector<HTMLCanvasElement>("#canvas")!;
const ctx = canvas.getContext("2d")!;
const stage = document.querySelector<HTMLElement>("#stage")!;
const viewport = document.querySelector<HTMLElement>("#viewport")!;
const taskTitle = document.querySelector<HTMLElement>("#task-title")!;
const taskDescription = document.querySelector<HTMLElement>("#task-description")!;
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
const home = document.querySelector<HTMLElement>("#home")!;
const announcements = document.querySelector<HTMLElement>("#announcements")!;
const cameraPlaceholder = document.querySelector<HTMLElement>("#camera-placeholder")!;
const handLabel = document.querySelector<HTMLElement>("#hand-label")!;
const labels: Record<ExerciseId, string> = { pinch: "Пинцет", grip: "Эспандер", hold: "Перенос", opposition: "Найди пару" };

const trainingChoice = document.querySelector<HTMLSelectElement>('#training-choice')!;
const pairOptions = document.querySelector<HTMLElement>('#pair-options')!;
const pairChoices = FINGER_TIPS.map(tip => ({ tip, input: document.querySelector<HTMLInputElement>(`#pair-${tip}`)! }));
const pairGuide = document.querySelector<SVGElement>('#pair-guide')!;
const finishAttemptButton = document.querySelector<HTMLButtonElement>('#btn-finish-attempt')!;
const skipPairButton = document.querySelector<HTMLButtonElement>('#btn-skip-pair')!;
function chooseTraining(): void { pairOptions.hidden = trainingChoice.value !== 'opposition'; }
trainingChoice.addEventListener('change', chooseTraining);
document.querySelector<HTMLButtonElement>('#btn-choose-pairs')!.addEventListener('click', () => {
  trainingChoice.value = 'opposition'; chooseTraining(); trainingChoice.focus();
});

const historyPanel = document.querySelector<HTMLElement>("#history")!;
const historyButton = document.querySelector<HTMLButtonElement>("#btn-history")!;
const storageNotice = document.querySelector<HTMLElement>("#storage-notice")!;
const store = new ProgressStore();
let program = store.data.current ? pauseProgram(createProgram(store.data.current), "results") : createProgram();
let mode: ExerciseId = program.session.currentExercise;
let sessionStarted = !!store.data.current;
function persist(timestampMs = performance.now(), force = false): void {
  if (sessionStarted) store.save(program.session, timestampMs, force);
  if (storageNotice.textContent !== store.notice) storageNotice.textContent = store.notice;
}
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
let sparkFlight: SparkFlight | null = null;
const motionPreference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
let reducedMotion = motionPreference?.matches ?? false;
motionPreference?.addEventListener("change", event => { reducedMotion = event.matches; });

function setHint(message: string, error = false, celebrating = false): void {
  // aria-live should announce changed states, not each camera frame.
  if (hint.textContent !== message) hint.textContent = message;
  const spoken = spokenHint(message);
  if (announcements.textContent !== spoken) announcements.textContent = spoken;
  cameraPlaceholder.hidden = running && video.readyState >= 2 && video.videoWidth > 0;
  if (error && !running) programStatus.textContent = "Запуск приостановлен";
  hint.classList.toggle("error", error);
  hint.classList.toggle("success", celebrating);
}

function updateScore(): void {
  const pairs = mode === 'opposition';
  if (pairs) pairGuide.removeAttribute('hidden'); else pairGuide.setAttribute('hidden', '');
  taskDescription.style.display = pairs ? 'block' : '';
  finishAttemptButton.hidden = skipPairButton.hidden = !pairs || !sessionStarted;
  finishAttemptButton.disabled = !program.session.attempts?.active || program.session.status !== 'in_progress';
  skipPairButton.disabled = !!program.session.attempts?.active || !!program.session.opposition?.awaitingRelease || program.session.status !== 'in_progress';
  if (pairs) {
    const tip = currentPair(program.session), counts = pairCounts(program.session), plan = program.session.opposition!;
    taskTitle.textContent = `Найди пару · большой + ${FINGER_NAMES[tip]}`;
    taskDescription.textContent = pairTask(tip);
    score.textContent = `Задания: ${counts.consumed} / ${plan.sequence.length} · Полностью: ${counts.completed}`;
    programStatus.textContent = `Пара ${plan.cursor + 1} из ${plan.sequence.length}`;
    pairGuide.setAttribute('aria-label', pairTask(tip));
    for (const point of [4, ...FINGER_TIPS]) document.querySelector(`#guide-tip-${point}`)!.classList.toggle('selected', point === 4 || point === tip);
    tabs.hidden = true;
    return;
  }
  const text = `${labels[mode]}: ${program.session.exercises[mode]!.reps} / ${program.session.exercises[mode]!.target}`;
  if (score.textContent !== text) score.textContent = text;
  const title = program.phase === "preparing" ? "Подготовим ладонь" : SCENES[mode].title;
  if (taskTitle.textContent !== title) taskTitle.textContent = title;
  if (taskDescription.textContent !== SCENES[mode].instruction) taskDescription.textContent = SCENES[mode].instruction;
  tabs.querySelectorAll<HTMLElement>("[data-mode]").forEach(tab => {
    const id = tab.dataset.mode as ExerciseId;
    const result = program.session.exercises[id]!;
    const state = result.reps === result.target ? "Готово" : id === mode ? "Сейчас" : "Далее";
    const text = `${EXERCISES.indexOf(id as BasicExerciseId) + 1}. ${{ pinch: "Огоньки", grip: "Мяч", hold: "Цели", opposition: "Пары" }[id]} · ${state}`;
    if (tab.textContent !== text) tab.textContent = text;
    tab.classList.toggle("active", id === mode);
    tab.setAttribute("aria-current", id === mode ? "step" : "false");
  });
  const status = program.phase === "preparing" ? "Подготовка руки"
    : program.phase === "paused" ? "Тренировка на паузе" : `Шаг ${EXERCISES.indexOf(mode as BasicExerciseId) + 1} из 3`;
  if (programStatus.textContent !== status) programStatus.textContent = status;
}

function resetTracking(): void {
  tracking = { previousWrongJoint: null, lastValidTimestamp: null };
  capture = null;
  dump.disabled = true;
  sparkFlight = null;
}

function resetFrameClock(): void {
  lastFrameTimestamp = null;
  lastVideoTime = -1;
  resetTracking();
}

function showExercise(): void {
  historyPanel.hidden = true;
  results.hidden = true;
  home.hidden = sessionStarted;
  stage.hidden = !sessionStarted;
  tabs.hidden = !sessionStarted || mode === "opposition";
  programStatus.hidden = !sessionStarted;
  hint.hidden = false;
  handLabel.hidden = sessionStarted;
  panel.hidden = false;
  start.hidden = running;
  pauseButton.hidden = !running;
  start.textContent = sessionStarted ? "Продолжить тренировку" : "Начать тренировку";
  historyButton.setAttribute("aria-expanded", "false");
  resultsButton.setAttribute("aria-expanded", "false");
  resultsButton.textContent = "Итоги";
}

function resumeExercise(): void {
  if (program.session.status !== "in_progress") return;
  showExercise();
  resetFrameClock();
  if (program.phase !== "intro") program = beginProgram(program);
  persist(performance.now(), true);
  pauseButton.textContent = "Пауза";
  pauseButton.setAttribute("aria-pressed", "false");
  if (!running) start.disabled = starting;
  setHint(running ? "Раскрой ладонь перед продолжением" : "Нажми «Продолжить тренировку», чтобы включить камеру");
  (running ? taskTitle : start).focus();
}

function rememberFinal(): void { persist(performance.now(), true); }

function newTraining(): void {
  stopCamera();
  rememberFinal();
  program = createProgram();
  sessionStarted = false;
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
  historyPanel.hidden = true;
  if (program.session.status === "in_progress") program = pauseProgram(program, "results", new Date().toISOString());
  if (program.session.status !== "in_progress" && running) stopCamera();
  resetFrameClock();
  stage.hidden = true;
  panel.hidden = true;
  results.hidden = false;
  home.hidden = true;
  hint.hidden = true;
  tabs.hidden = true;
  programStatus.hidden = true;
  historyButton.setAttribute("aria-expanded", "false");
  resultsButton.setAttribute("aria-expanded", "true");
  resultsButton.textContent = program.session.status === "in_progress" ? "К упражнениям" : "Итоги";
  persist(performance.now(), true);
  renderResults(results, program.session, resumeExercise, finishTraining, newTraining);
}

function setDebugVisibility(): void {
  debug.hidden = !debugEnabled;
  dump.hidden = !debugEnabled;
}

function stopCamera(): void {
  persist(performance.now(), true);
  generation++;
  running = false;
  cancelAnimationFrame(requestId);
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  video.srcObject = null;
  tracker?.close();
  tracker = null;
  start.disabled = starting;
  start.hidden = false;
  pauseButton.hidden = true;
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
  if (name === "NotAllowedError" || name === "SecurityError") return "Доступ к камере запрещён. Разрешите доступ в браузере и повторите запуск.";
  if (name === "NotFoundError") return "Камера не найдена. Подключите камеру и повторите.";
  if (name === "NotReadableError") return "Камера недоступна. Закройте другие приложения, использующие камеру.";
  return "Не удалось загрузить распознавание руки. Проверь подключение и повтори запуск. Если ошибка остаётся, перезагрузи страницу.";
}

function processFrame(timestampMs: number): void {
  if (program.phase === "summary" || (program.phase === "paused" && program.pauseReason !== "tracking")) return;
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    if (width > 0 && height > 0) viewport.style.aspectRatio = `${width} / ${height}`;
    // A changed scene invalidates partial holds and requires readiness again.
    if (program.phase === "exercise") program = beginProgram(program, "resize");
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
  const tracked = mode === "opposition" ? { state: tracking, reading: null } : stepPinchTracking(tracking, g, timestampMs);
  tracking = tracked.state;
  const target = width > 0 && height > 0 ? guidedTarget(width, height, program.session.exercises.hold.reps) : null;
  const previousSuccess = program.success;
  program = stepProgram(program, {
    timestampMs, wallTime: new Date().toISOString(), geometry: g, fullHand,
    pinch: tracked.reading, palm: g ? mirrorPoint(g.palmCenter(), width) : null, target,
  });
  persist(timestampMs);
  if (g && program.success && program.success !== previousSuccess && program.success.exercise === "pinch") {
    sparkFlight = { at: program.success.at, action: program.success.reps,
      from: mirroredPinchPoint(g.pts, width) };
  }
  mode = program.session.currentExercise;
  if (program.phase === "summary") {
    rememberFinal();
    stopCamera();
    showResults();
    return;
  }
  const reading = program.reading;
  if (!g || reading?.error) sparkFlight = null;
  const instruction = programInstruction(program, timestampMs);
  const feedback = getFeedback({
    exercise: mode, timestampMs, visible: !!g, error: reading?.error ?? null,
    phase: program.fsm.phase, success: program.success, instruction,
    target: program.session.exercises[mode]!.target,
  });
  if (program.phase === "paused") setHint(instruction);
  else if (mode === 'opposition') setHint(feedback.text, feedback.error, feedback.celebrating);
  else if (g && (program.phase === "preparing" || program.phase === "transition")) setHint(instruction);
  else setHint(feedback.text, feedback.error, feedback.celebrating);
  updateScore();
  pauseButton.disabled = false;
  const missingMs = g || tracking.lastValidTimestamp === null ? 0 : timestampMs - tracking.lastValidTimestamp;
  const nextTarget = width > 0 && height > 0 ? guidedTarget(width, height, program.session.exercises.hold.reps) : null;
  drawHandOverlay(ctx, g ? landmarks : null, reading, {
    enabled: debugEnabled, success: feedback.success, fps, handSizeNorm: g?.handSizeNorm ?? null,
    nullTimeoutMs: DEFAULT_CONFIG.NULL_TIMEOUT_MS, missingMs,
    gripOpenness: mode === "grip" && g && program.calibration ? gripOpenness(g, program.calibration) : undefined,
    target: mode === "hold" && nextTarget ? { ...nextTarget, progress: program.hold.holdMs / HOLD_TARGET_MS } : undefined,
    pairTip: mode === "opposition" ? currentPair(program.session) : undefined,
    scene: mode === "opposition" ? undefined : {
      exercise: mode, completed: program.session.exercises[mode]!.reps, timestampMs, reducedMotion,
      pinchPoint: g ? mirroredPinchPoint(g.pts, width) : null,
      palm: g ? mirrorPoint(g.palmCenter(), width) : null,
      openPalm: !!reading?.open,
      openness: g && program.calibration ? gripOpenness(g, program.calibration) : null,
      targets: [0, 1, 2].map(index => guidedTarget(width, height, index)),
      holdProgress: program.hold.holdMs / HOLD_TARGET_MS, flight: sparkFlight,
    },
  });
  updateDebug(debug, g, fps, {
    program: program.phase, phase: program.fsm.phase, error: reading?.error?.code ?? null,
    previousWrongJoint: tracking.previousWrongJoint, missingMs, timeoutMs: DEFAULT_CONFIG.NULL_TIMEOUT_MS, width, height,
  });
  capture = g && landmarks && reading ? {
    timestamp: timestampMs, exercise: mode, videoWidth: width, videoHeight: height,
    landmarks: landmarks.map(p => ({ x: p.x, y: p.y, z: p.z })), observedReading: reading,
  } : null;
  dump.disabled = capture === null;
}

function loop(timestampMs: number): void {
  if (!running) return;
  try {
    processFrame(timestampMs);
  } catch {
    program = pauseProgram(program, "camera", new Date().toISOString());
    stopCamera();
    setHint("Ошибка обработки кадра. Повторите запуск камеры.", true);
    return;
  }
  if (running) requestId = requestAnimationFrame(loop);
}

start.addEventListener("click", async () => {
  if (running || starting || start.disabled || program.session.status !== "in_progress") return;
  if (!sessionStarted && trainingChoice.value === 'opposition') {
    const allowed = pairChoices.filter(choice => choice.input.checked).map(choice => choice.tip);
    if (!allowed.length) { setHint('Выбери хотя бы одну пару пальцев', true); return; }
    program = createProgram(createOppositionSession(allowed));
  }
  program = beginProgram(program);
  mode = program.session.currentExercise;
  const hand = handChoice.value;
  if (!Object.values(program.session.exercises).some(result => result.started)) {
    program = { ...program, session: { ...program.session, hand: hand === "left" || hand === "right" ? hand : "unspecified" } };
  }
  handChoice.disabled = true;
  sessionStarted = true;
  persist(performance.now(), true);
  showExercise();
  updateScore();
  if (!navigator.mediaDevices?.getUserMedia) {
    setHint("Камера доступна только через HTTPS или localhost в поддерживаемом браузере.", true);
    return;
  }
  const token = ++generation;
  starting = true;
  start.disabled = true;
  programStatus.textContent = "Подключение камеры";
  setHint("Разреши доступ к камере. Подключаем видео…");
  try {
    const newStream = await initCamera(video);
    if (token !== generation) { newStream.getTracks().forEach(track => track.stop()); return; }
    stream = newStream;
    programStatus.textContent = "Загрузка распознавания";
    setHint("Камера подключена. Загружаем распознавание руки…");
    const newTracker = await initTracker();
    if (token !== generation) { newTracker.close(); return; }
    tracker = newTracker;
    running = true;
    start.hidden = true;
    pauseButton.hidden = false;
    calibrateButton.disabled = true;
    pauseButton.disabled = false;
    for (const track of stream.getTracks()) track.addEventListener("ended", () => {
      if (!running) return;
      program = pauseProgram(program, "camera", new Date().toISOString());
      stopCamera();
      setHint("Камера отключена. Подключите её и повторите запуск.", true);
    });
    requestId = requestAnimationFrame(loop);
  } catch (error) {
    if (token !== generation) return;
    program = pauseProgram(program, "camera", new Date().toISOString());
    stopCamera();
    setHint(cameraError(error), true);
  } finally {
    starting = false;
    start.disabled = running;
  }
});

// Step labels describe progress; they are not mode-switching controls.
calibrateButton.hidden = true;
pauseButton.addEventListener("click", () => {
  if (program.phase === "paused" && program.pauseReason !== "tracking") {
    program = beginProgram(program);
    resetFrameClock();
    pauseButton.textContent = "Пауза";
    setHint("Раскрой ладонь перед продолжением");
  } else {
    program = pauseProgram(program, "manual", new Date().toISOString());
    resetFrameClock();
    pauseButton.textContent = "Продолжить";
    setHint("Тренировка на паузе. Нажми «Продолжить»");
  }
  if (program.phase === 'summary') { rememberFinal(); stopCamera(); showResults(); return; }
  pauseButton.setAttribute("aria-pressed", String(program.phase === "paused"));
  updateScore();
  persist(performance.now(), true);
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
    program = pauseProgram(program, "visibility", new Date().toISOString());
    stopCamera();
    setHint("Камера остановлена. Нажмите «Продолжить тренировку» для продолжения.");
  }
});
window.addEventListener("pagehide", () => {
  program = pauseProgram(program, "visibility", new Date().toISOString());
  stopCamera();
});
if (import.meta.hot) import.meta.hot.dispose(stopCamera);
setDebugVisibility();
dump.disabled = true;
updateScore();
setHint("Выбери руку и нажми «Начать тренировку»");

historyButton.addEventListener("click", () => {
  if (program.session.status === "in_progress" && sessionStarted) program = pauseProgram(program, "results", new Date().toISOString());
  stopCamera();
  stage.hidden = true;
  panel.hidden = true;
  results.hidden = true;
  historyPanel.hidden = false;
  home.hidden = true;
  hint.hidden = true;
  tabs.hidden = true;
  programStatus.hidden = true;
  historyButton.setAttribute("aria-expanded", "true");
  resultsButton.setAttribute("aria-expanded", "false");
  resultsButton.textContent = "Итоги";
  renderHistory(historyPanel, store, () => sessionStarted ? showResults() : showExercise());
});
storageNotice.textContent = store.notice;
showExercise();
if (store.data.current) {
  handChoice.value = program.session.hand;
  handChoice.disabled = true;
  showResults();
  const interrupted = document.createElement("p");
  interrupted.textContent = "Тренировка прервана перезагрузкой. Продолжи с повторной подготовкой руки или заверши с текущим результатом. Пропущенное время не учитывается.";
  results.append(interrupted);
}

function afterPairAction(): void {
  persist(performance.now(), true);
  updateScore();
  if (program.phase === 'summary') { stopCamera(); showResults(); }
  else setHint(programInstruction(program, performance.now()));
}
finishAttemptButton.addEventListener('click', () => {
  program = finishOppositionAttempt(program, new Date().toISOString()); afterPairAction();
});
skipPairButton.addEventListener('click', () => {
  program = skipOppositionPair(program, new Date().toISOString()); afterPairAction();
});

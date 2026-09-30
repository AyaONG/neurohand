import { holdGoalIndex } from './hold-target';
import { configureReportOwner, pdfButton } from './report-actions';
import { MovementEvents } from './movement-feedback';
import { closeGoal } from './flow';
import { routeSession, nextRouteSession, type Route } from './route';
import { finishAttempt } from './attempts';
import { settleOpposition } from './opposition';
import { settleRing } from './ring';
import { currentGoalText } from './goals';
import { modeEnabled } from './release-flags';
import { SyncEngine, supabaseTransport } from './sync';
import { exportAggregates, importAggregates, MAX_TRANSFER_BYTES } from './transfer';
import { cloudConfig, AuthController } from './cloud';
import { Profiles, userOwner } from './profiles';

import { RING_NAMES, RING_TIPS, screenPoint, type RingTip } from './ring';
import { finishRingAttempt } from './ring-program';

import { currentPair, FINGER_TIPS, ALL_PAIR_KEYS, pairOf, pairLabel, pairCounts, pairTask } from './opposition';
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
import { renderHistory, refreshHistory } from "./history";
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
const labels: Record<ExerciseId, string> = { pinch: "Пинцет", grip: "Эспандер", hold: "Перенос", opposition: "Найди пару", ring: "Обведи кольцо" };

const trainingChoice = document.querySelector<HTMLSelectElement>('#training-choice')!;
const ringOptions = document.querySelector<HTMLElement>('#ring-options')!;
const ringTipChoice = document.querySelector<HTMLSelectElement>('#ring-tip')!;
const pairOptions = document.querySelector<HTMLElement>('#pair-options')!;
const pairChoices = ALL_PAIR_KEYS.map(tip => ({ tip, input: document.querySelector<HTMLInputElement>(`#pair-${tip}`)! }));
const pairGuide = document.querySelector<SVGElement>('#pair-guide')!;
const finishAttemptButton = document.querySelector<HTMLButtonElement>('#btn-finish-attempt')!;
const skipPairButton = document.querySelector<HTMLButtonElement>('#btn-skip-pair')!;
for (const [mode, card, option] of [
  ['opposition', 'card-pairs', 'option-pairs'], ['ring', 'card-ring', 'option-ring'],
] as const) {
  const enabled = modeEnabled(mode);
  document.querySelector<HTMLElement>(`#${card}`)!.hidden = !enabled;
  const entry = document.querySelector<HTMLOptionElement>(`#${option}`)!;
  entry.hidden = entry.disabled = !enabled;
}
function selectedModes(): Route['blocks'][number]['mode'][] {
  return [trainingChoice.value, ...['guided','opposition','ring'].filter(m => document.querySelector<HTMLInputElement>(`#route-${m}`)?.checked)]
    .filter((m,i,a) => a.indexOf(m)===i && modeEnabled(m)) as Route['blocks'][number]['mode'][];
}
function chooseTraining(): void {
  if (!modeEnabled(trainingChoice.value)) trainingChoice.value = 'guided';
  for (const name of ['guided','opposition','ring']) {
    const input=document.querySelector<HTMLInputElement>(`#route-${name}`), label=document.querySelector<HTMLElement>(`#route-${name}-label`);
    if(input){input.disabled=sessionStarted || !modeEnabled(name) || name===trainingChoice.value;if(name===trainingChoice.value)input.checked=false;}
    if(label)label.hidden=name===trainingChoice.value || !modeEnabled(name);
  }
  const modes=selectedModes();
  ringOptions.hidden=!modes.includes('ring');pairOptions.hidden=!modes.includes('opposition');
  trainingChoice.disabled=ringTipChoice.disabled=sessionStarted;
  const auto=document.querySelector<HTMLInputElement>('#automatic-flow');if(auto)auto.disabled=sessionStarted;
  for(const c of pairChoices)c.input.disabled=sessionStarted || !modeEnabled('opposition');
  for(const id of ['pairs-all','pairs-none']) {const button=document.querySelector<HTMLButtonElement>(`#${id}`);if(button)button.disabled=sessionStarted || !modeEnabled('opposition');}
  const n=pairChoices.filter(c=>c.input.checked).length;
  const count=document.querySelector<HTMLElement>('#pair-selection');if(count)count.textContent=`Выбрано ${n} из 10 · целей: ${n*2}`+(n?'':' · Выбери хотя бы одну пару для запуска');
  const order=document.querySelector<HTMLElement>('#route-order');if(order)order.textContent='Маршрут: '+modes.map(m=>({guided:'Базовая программа',opposition:'Пары',ring:'Кольцо'})[m]).join(' → ');
  if(!sessionStarted) {start.disabled=starting || (modes.includes('opposition') && n===0); if(modes.includes('opposition') && n===0)setHint('Выбери хотя бы одну пару для запуска');}
}
trainingChoice.addEventListener('change', chooseTraining);
for(const c of pairChoices)c.input.addEventListener('change',chooseTraining);
for(const [id,checked] of [['pairs-all',true],['pairs-none',false]] as const) document.querySelector<HTMLButtonElement>(`#${id}`)?.addEventListener('click',()=>{
  if(sessionStarted || !modeEnabled('opposition'))return;
  pairChoices.forEach(c=>{c.input.checked=checked;});
  const details=document.querySelector<HTMLDetailsElement>('#experimental-pairs');if(details && checked)details.open=true;
  chooseTraining();
});
for (const name of ['guided','opposition','ring']) {
 const input = document.querySelector<HTMLInputElement>(`#route-${name}`);
 if (input) { input.disabled = !modeEnabled(name); input.addEventListener('change', chooseTraining); }
}
document.querySelector<HTMLButtonElement>('#btn-choose-pairs')!.addEventListener('click', () => {
  trainingChoice.value = 'opposition'; chooseTraining(); trainingChoice.focus();
});

document.querySelector<HTMLButtonElement>('#btn-choose-ring')!.addEventListener('click', () => { trainingChoice.value = 'ring'; chooseTraining(); trainingChoice.focus(); });

const historyPanel = document.querySelector<HTMLElement>("#history")!;
const historyButton = document.querySelector<HTMLButtonElement>("#btn-history")!;
const storageNotice = document.querySelector<HTMLElement>("#storage-notice")!;
let sync: SyncEngine | null = null;
const profiles = new Profiles();
configureReportOwner(() => { const ticket = profiles.ticket(); return () => profiles.accepts(ticket); });
let store = profiles.store;
let program = store.data.current ? pauseProgram(createProgram(store.data.current), "results") : createProgram();
let mode: ExerciseId = program.session.currentExercise;
let sessionStarted = !!store.data.current;
function persist(timestampMs = performance.now(), force = false): void {
  if (sessionStarted) store.save(program.session, timestampMs, force);
  if (sessionStarted && program.session.status !== "in_progress") void sync?.flush();
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
let movementEvents = new MovementEvents(program.session.attempts);
const successStar = document.querySelector<HTMLElement>('#success-star');
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
  taskDescription.style.display = pairs || mode === 'ring' ? 'block' : '';
  finishAttemptButton.hidden = skipPairButton.hidden = (!pairs && !program.session.attempts?.flow) || !sessionStarted;
  finishAttemptButton.hidden = !sessionStarted || (!pairs && mode !== 'ring');
  finishAttemptButton.disabled = !program.session.attempts?.active || program.session.status !== 'in_progress';
  skipPairButton.textContent = program.session.attempts?.flow ? 'Пропустить цель' : 'Пропустить пару';
  skipPairButton.disabled = program.phase === 'transition' || (!program.session.attempts?.flow && !!program.session.attempts?.active) || !!program.session.opposition?.awaitingRelease || program.session.status !== 'in_progress';
  if (mode === 'ring') {
    const active = program.session.attempts?.active ?? program.session.attempts?.records.at(-1);
    const metrics = active?.metrics;
    taskTitle.textContent = `Обведи кольцо · ${RING_NAMES[program.session.ring!.tip]}`;
    taskDescription.textContent = 'Экранный путь кончика. Можно двигать всей кистью. По часовой стрелке, до 15 с на попытку.';
    score.textContent = `Отметки: ${metrics?.kind === 'ring' ? metrics.marks : 0} / 12 · затем вернись на старт`;
    programStatus.textContent = currentGoalText(program.session) || 'Одно задание · частичный путь тоже сохранится'; tabs.hidden = true; return;
  }
  if (pairs) {
    const tip = currentPair(program.session), counts = pairCounts(program.session), plan = program.session.opposition!;
    taskTitle.textContent = `Найди пару · ${pairLabel(tip)}`;
    taskDescription.textContent = pairTask(tip);
    score.textContent = `Выполнено: ${counts.completed} / ${plan.sequence.length} · Пропущено: ${counts.skipped} · Попытки: ${counts.completed + counts.partial + counts.incomplete} оценённых`;
    programStatus.textContent = currentGoalText(program.session) || `Пара ${plan.cursor + 1} из ${plan.sequence.length}`;
    pairGuide.setAttribute('aria-label', pairTask(tip));
    for (const point of [4, ...FINGER_TIPS]) document.querySelector(`#guide-tip-${point}`)!.classList.toggle('selected', pairOf(tip).includes(point as 4 | 8 | 12 | 16 | 20));
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
    const closed = program.session.attempts?.runs?.find(r => r.exerciseId === id)?.goalIds.every(goalId => program.session.attempts?.flow?.goals.some(g => g.goalId === goalId && g.reason));
    const state = result.reps === result.target ? "Готово" : closed ? "Пройдено" : id === mode ? "Сейчас" : "Далее";
    const text = `${EXERCISES.indexOf(id as BasicExerciseId) + 1}. ${{ pinch: "Огоньки", grip: "Мяч", hold: "Цели", opposition: "Пары", ring: "Кольцо" }[id]} · ${state}`;
    if (tab.textContent !== text) tab.textContent = text;
    tab.classList.toggle("active", id === mode);
    tab.setAttribute("aria-current", id === mode ? "step" : "false");
  });
  const status = program.phase === "preparing" ? "Подготовка руки"
    : program.phase === "paused" ? "Тренировка на паузе" : (currentGoalText(program.session) || `Шаг ${EXERCISES.indexOf(mode as BasicExerciseId) + 1} из 3`);
  if (programStatus.textContent !== status) programStatus.textContent = status;
}

function resetTracking(): void {
  tracking = { previousWrongJoint: null, lastValidTimestamp: null };
  capture = null;
  dump.disabled = true;
  sparkFlight = null;
  if (successStar) successStar.hidden = true;
}

function resetFrameClock(): void {
  lastFrameTimestamp = null;
  lastVideoTime = -1;
  resetTracking();
}

function showExercise(): void {
  document.querySelector<HTMLElement>(sessionStarted ? '#live-controls' : '#setup-start')?.append(panel);
  chooseTraining();
  historyPanel.hidden = true;
  results.hidden = true;
  home.hidden = sessionStarted;
  stage.hidden = !sessionStarted;
  tabs.hidden = !sessionStarted || program.session.mode !== "guided";
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
  if (!modeEnabled(program.session.mode)) { showResults(); return; }
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
  movementEvents = new MovementEvents(program.session.attempts);
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
  renderResults(results, program.session, resumeExercise, finishTraining, newTraining, store.storageLabel(program.session.id));
  const route = program.session.attempts?.route;
  if (route) {
    const linked = store.data.history.filter(s => s.attempts?.route?.trainingRunId === route.trainingRunId);
    const summary = document.createElement('p');
    summary.textContent = `Маршрут: ${linked.length} из ${route.blocks.length} блоков завершено. Выполнено целей: ${linked.reduce((n,s) => n + (s.attempts?.records.filter(a => a.outcome === 'completed').length ?? 0), 0)}.`;
    results.append(summary);
    if (linked.length > 1) results.append(pdfButton(linked, { filterLabel: "Все завершённые блоки выбранного маршрута" }));
  }
  if (program.session.status === 'in_progress' && !modeEnabled(program.session.mode)) {
    const resume = results.querySelector<HTMLButtonElement>('#btn-resume');
    if (resume) resume.disabled = true;
    const note = document.createElement('p');
    note.textContent = 'Этот режим временно отключён. Заверши занятие с текущими результатами, затем выбери базовую программу.';
    results.append(note);
  }
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
  if ((program.phase === "paused" && program.pauseReason !== "tracking")) return;
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
  const tracked = program.session.mode !== "guided" ? { state: tracking, reading: null } : stepPinchTracking(tracking, g, timestampMs);
  tracking = tracked.state;
  const target = width > 0 && height > 0 ? guidedTarget(width, height, holdGoalIndex(program.session), program.session.settings.targetRadiusRatio) : null;
  program = stepProgram(program, {
    timestampMs, wallTime: new Date().toISOString(), geometry: g, fullHand, trackingReason: landmarks && !g ? 'quality' : 'tracking',
    ring: mode === 'ring' ? { width, height, point: g && landmarks ? screenPoint(landmarks[program.session.ring!.tip], width, height) : null } : undefined,
    pinch: tracked.reading, palm: g ? mirrorPoint(g.palmCenter(), width) : null, target,
  });
  persist(timestampMs);
  const event = movementEvents.update(program.session.attempts, timestampMs);
  const eventVisible = !!event && timestampMs - event.at < 900;
  if (successStar) {
    successStar.hidden = !eventVisible || !event?.completed || !g;
    if (successStar.dataset.event !== event?.id) successStar.dataset.event = event?.id ?? '';
    successStar.classList.toggle('still', reducedMotion);
  }
  mode = program.session.currentExercise;
  if (program.phase === "summary" && !eventVisible) {
    rememberFinal();
    const next = nextRouteSession(program.session, store.data.history);
    if (next && modeEnabled(next.mode)) {
      program = beginProgram(createProgram(next)); mode = program.session.currentExercise;
      resetFrameClock(); persist(timestampMs, true); showExercise(); updateScore(); return;
    }
    stopCamera(); showResults(); return;
  }
  const reading = program.reading;
  if (!g || reading?.error) sparkFlight = null;
  const instruction = programInstruction(program, timestampMs);
  const feedback = getFeedback({
    event, exercise: mode, timestampMs, visible: !!g, error: reading?.error ?? null,
    phase: program.fsm.phase, success: program.success, instruction,
    target: program.session.exercises[mode]!.target,
  });
  if (program.phase === "paused") setHint(instruction);
  else if (mode === 'opposition' || mode === 'ring') setHint(feedback.text, feedback.error, feedback.celebrating);
  else if (!eventVisible && !feedback.celebrating && g && (program.phase === "preparing" || program.phase === "transition")) setHint(instruction);
  else setHint(feedback.text, feedback.error, feedback.celebrating);
  updateScore();
  pauseButton.disabled = false;
  const missingMs = g || tracking.lastValidTimestamp === null ? 0 : timestampMs - tracking.lastValidTimestamp;
  const nextTarget = width > 0 && height > 0 ? guidedTarget(width, height, holdGoalIndex(program.session), program.session.settings.targetRadiusRatio) : null;
  drawHandOverlay(ctx, g ? landmarks : null, reading, {
    enabled: debugEnabled, success: feedback.success, fps, handSizeNorm: g?.handSizeNorm ?? null,
    nullTimeoutMs: DEFAULT_CONFIG.NULL_TIMEOUT_MS, missingMs,
    gripOpenness: mode === "grip" && g && program.calibration ? gripOpenness(g, program.calibration) : undefined,
    target: mode === "hold" && nextTarget ? { ...nextTarget, progress: program.hold.holdMs / HOLD_TARGET_MS } : undefined,
    pairTip: mode === "opposition" && typeof currentPair(program.session) === 'number' ? currentPair(program.session) as 8 | 12 | 16 | 20 : undefined,
    pair: mode === 'opposition' ? pairOf(currentPair(program.session)) : undefined,
    ring: mode === 'ring' ? { tip: program.session.ring!.tip, marks: program.session.attempts?.active?.metrics.kind === 'ring' ? program.session.attempts.active.metrics.marks : 0 } : undefined,
    scene: program.session.mode !== 'guided' ? undefined : {
      exercise: mode, completed: program.session.exercises[mode]!.reps, timestampMs, reducedMotion,
      pinchPoint: g ? mirroredPinchPoint(g.pts, width) : null,
      palm: g ? mirrorPoint(g.palmCenter(), width) : null,
      openPalm: !!reading?.open,
      openness: g && program.calibration ? gripOpenness(g, program.calibration) : null,
      holdGoalIndex: holdGoalIndex(program.session),
      holdCompleted: program.session.attempts?.flow ? program.session.attempts.runs?.find(r => r.exerciseId === "hold")?.goalIds.flatMap((id,i) => program.session.attempts!.records.some(a => a.goalId === id && a.outcome === "completed") ? [i] : []) : undefined,
      targets: [0, 1, 2].map(index => guidedTarget(width, height, index, program.session.settings.targetRadiusRatio)),
      holdProgress: program.hold.holdMs / HOLD_TARGET_MS, flight: sparkFlight,
    },
  });
  updateDebug(debug, g, fps, {
    holdResets: debugEnabled ? JSON.stringify(program.holdResets) : null, holdMs: program.hold.holdMs,
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
  if(!sessionStarted && !modeEnabled(trainingChoice.value)){setHint('Этот режим временно отключён.',true);return;}
  if(!authBusy && !sessionStarted) chooseTraining();
  if (running || starting || start.disabled || program.session.status !== "in_progress") return;
  if (!modeEnabled(sessionStarted ? program.session.mode : trainingChoice.value)) {
    setHint('Этот режим временно отключён. Сохрани текущие итоги и выбери базовую программу.', true); return;
  }
  if (!sessionStarted) {
    const modes = selectedModes();
    const allowed = pairChoices.filter(choice => choice.input.checked).map(choice => choice.tip);
    if (modes.includes('opposition') && !allowed.length) { setHint('Выбери хотя бы одну пару пальцев', true); return; }
    const tip = Number(ringTipChoice.value) as RingTip;
    const route: Route = { trainingRunId: crypto.randomUUID(), index: 0, blocks: modes.map(mode => ({ mode, id: crypto.randomUUID() })), pairs: allowed.length ? allowed : [8], ringTip: RING_TIPS.includes(tip) ? tip : 8 };
    program = createProgram(routeSession(route, document.querySelector<HTMLInputElement>('#automatic-flow')?.checked ?? false,
      handChoice.value === 'left' || handChoice.value === 'right' ? handChoice.value : 'unspecified'));
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
      if (!running || token !== generation) return;
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
if (!store.data.current) {
  const last = [...store.data.history].sort((a,b) => Date.parse(b.endedAt!) - Date.parse(a.endedAt!))[0];
  const next = last && nextRouteSession(last, store.data.history);
  if (next) { program = createProgram({ ...next, paused: true }); sessionStarted = true; mode = next.currentExercise; persist(performance.now(), true); }
}
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
  program = (mode === 'ring' ? finishRingAttempt : finishOppositionAttempt)(program, new Date().toISOString()); afterPairAction();
});
skipPairButton.addEventListener('click', () => {
  const wall = new Date().toISOString();
  if (program.session.attempts?.flow) {
    const log = program.session.attempts!;
    const attempts = log.active ? finishAttempt(log, log.active.attemptId, 'cancelled', 'manual', wall) : log;
    const session = settleRing(settleOpposition({ ...program.session, attempts }));
    program = { ...program, session: closeGoal(session, 'manual_skip', wall), phase: session.paused ? 'paused' : 'transition' };
  } else program = skipOppositionPair(program, wall);
  afterPairAction();
});

window.addEventListener('resize', () => {
  if (program.session.mode !== 'ring' || program.session.status !== 'in_progress' || program.phase === 'paused') return;
  program = beginProgram(program, 'resize'); resetFrameClock(); persist(performance.now(), true); updateScore();
});


// Identity changes first save to the OLD owner's store, then clear every old view.
function switchProfile(id: string | null): void {
  const owner = userOwner(id);
  if (profiles.owner === owner) return;
  if (sessionStarted && program.session.status === 'in_progress') program = pauseProgram(program, 'manual', new Date().toISOString());
  stopCamera();
  store = profiles.switchTo(owner);
  program = store.data.current ? pauseProgram(createProgram(store.data.current), 'results') : createProgram();
  sessionStarted = !!store.data.current; mode = program.session.currentExercise;
  movementEvents = new MovementEvents(program.session.attempts);
  historyPanel.replaceChildren(); results.replaceChildren();
  ctx.clearRect(0, 0, canvas.width, canvas.height); resetFrameClock();
  handChoice.value = sessionStarted ? program.session.hand : 'unspecified'; handChoice.disabled = sessionStarted;
  showExercise(); updateScore(); storageNotice.textContent = store.notice;
  const accountNotice=document.querySelector<HTMLElement>('#account-notice');
  if(accountNotice)accountNotice.textContent='Аккаунт переключён. Показаны его занятия.';
  setHint('Выбери занятие и нажми «Начать тренировку»');
  guestImportPanel.replaceChildren(); guestImportPanel.hidden = true; transferMessage(''); importFile.value = '';
  if (sessionStarted) showResults();
  sync?.reset();
}
const cloud = cloudConfig({ VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY });
const syncStatus = document.querySelector<HTMLElement>('#sync-status')!;
const syncRetry = document.querySelector<HTMLButtonElement>('#btn-sync-retry')!;
const syncMore = document.querySelector<HTMLButtonElement>('#btn-cloud-more')!;
const guestImportButton = document.querySelector<HTMLButtonElement>('#btn-import-guest')!;
const guestImportPanel = document.querySelector<HTMLElement>('#guest-import')!;
const exportButton = document.querySelector<HTMLButtonElement>('#btn-export-json')!;
const importFile = document.querySelector<HTMLInputElement>('#import-json')!;
let accountPdfOwner: string | null=null;
function refreshSyncUI(): void {
  const account = profiles.owner !== 'guest';
  syncMore.hidden = !account;
  guestImportButton.hidden = !account || !profiles.guestHistory().length;
  importFile.disabled = account;
  if (sync) {
    const saved = store.data.history.filter(s => store.syncState(s.id)?.status === 'saved').length;
    const errors = store.data.history.filter(s => store.syncState(s.id)?.status === 'error').length;
    syncStatus.hidden = false;
    const pending=profiles.pending().length;
    syncRetry.hidden=!account || (!pending && !errors && !sync.message);
    syncStatus.textContent=!store.durable ? 'История сейчас только в памяти — скачай отчёт или резервную копию.' : !account ? 'Прогресс сохраняется в этом браузере' :
      errors ? `Не удалось сохранить: ${errors}. Повтори отправку.` : pending ? `Ожидает отправки: ${pending}${sync.isOnline?'':' · Нет сети'}` : saved ? `Сохранено в аккаунте: ${saved}` : 'Новых сохранённых занятий пока нет';
    const details=document.querySelector<HTMLElement>('#sync-details');if(details)details.textContent=`Сохранено: ${saved} · ожидает отправки: ${pending} · ошибки: ${errors}. ${sync.message}`;
    const pdf=document.querySelector<HTMLElement>('#account-pdf');
    if(pdf && accountPdfOwner!==profiles.owner){accountPdfOwner=profiles.owner;pdf.replaceChildren(pdfButton(()=>store.data.history,{filterLabel:'Вся загруженная история текущего аккаунта или гостя. Для периода и фильтров открой «Мой прогресс».'}));}

    syncMore.disabled = sync.loading || !sync.more;
    if (!historyPanel.hidden) refreshHistory(historyPanel);
    const resultStorage = results.querySelector<HTMLElement>('#result-storage-status');
    if (resultStorage && sessionStarted) resultStorage.textContent = store.storageLabel(program.session.id);
  }
  storageNotice.textContent = store.notice;
}
sync = new SyncEngine(profiles, cloud.client ? supabaseTransport(cloud.client) : null, refreshSyncUI);
syncRetry.addEventListener('click', () => sync!.retry());
syncMore.addEventListener('click', () => { void sync!.loadMore(); });
window.addEventListener('offline', () => { sync!.setOnline(false); refreshSyncUI(); });
window.addEventListener('online', () => sync!.setOnline(true));
if (navigator.onLine === false) sync.setOnline(false);
const authStatus = document.querySelector<HTMLElement>('#auth-status')!;
const signInButton = document.querySelector<HTMLButtonElement>('#btn-sign-in')!;
const signOutButton = document.querySelector<HTMLButtonElement>('#btn-sign-out')!;
let authBusy = false;
const auth = new AuthController(cloud.client, switchProfile, state => {
  authStatus.textContent = state.text + (debugEnabled && state.diagnostic && state.diagnostic !== 'none' ? ` · auth:${state.diagnostic}` : '');
  if (state.busy) {
    historyPanel.hidden = results.hidden = stage.hidden = home.hidden = panel.hidden = tabs.hidden = true;
  } else if (authBusy) {
    if (sessionStarted) showResults(); else showExercise();
  }
  authBusy = state.busy;
  document.querySelector<HTMLElement>('#sync-panel')!.hidden = state.busy;
  if (!state.busy) {
    refreshSyncUI();
    // Auth callbacks stay synchronous; SDK requests start after the callback releases its lock.
    queueMicrotask(() => { void sync?.flush(); if (state.userId) void sync?.loadMore(true); });
  }
  signInButton.hidden = !cloud.client || !!state.userId || state.canSignOut;
  signOutButton.hidden = !state.canSignOut;
  signInButton.disabled = signOutButton.disabled = state.busy;
  start.disabled = state.busy || running || starting;
  if(!state.busy && !sessionStarted)chooseTraining();
  historyButton.disabled = resultsButton.disabled = state.busy;
}, cloud.notice, cloud.checkGoogle);
signInButton.addEventListener('click', () => auth.signIn(location.origin, () => {
  if (sessionStarted) program = pauseProgram(program, 'manual', new Date().toISOString());
  stopCamera();
}));
signOutButton.addEventListener('click', () => auth.signOut());
void auth.start(location.href, url => window.history.replaceState(null, '', url));
if (import.meta.hot) import.meta.hot.dispose(() => auth.dispose());


function transferMessage(text: string) { document.querySelector<HTMLElement>('#transfer-status')!.textContent = text; }
guestImportButton.addEventListener('click', () => {
  const ticket = profiles.ticket(); if (ticket.owner === 'guest') return;
  guestImportPanel.hidden = false; guestImportPanel.replaceChildren();
  const records = profiles.guestHistory();
  if(!records.length){guestImportPanel.hidden=true;transferMessage('Гостевых занятий для добавления пока нет.');return;}
  const description = document.createElement('p'); description.textContent = 'Выбери гостевые занятия для добавления в текущий аккаунт. Исходные гостевые записи останутся.';
  guestImportPanel.append(description);
  const choices = records.map(s => {
    const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox';
    const text = document.createElement('span'); text.textContent = `${new Date(s.endedAt!).toLocaleString('ru-RU')} · ${{ guided: 'Базовая программа', ring: 'Обведи кольцо', opposition: 'Найди пару' }[s.mode]} · ${{ left: 'Левая', right: 'Правая', unspecified: 'Рука не выбрана' }[s.hand]}`;
    label.append(input, text); guestImportPanel.append(label); return { input, id: s.id };
  });
  const confirm = document.createElement('button'); confirm.textContent = 'Добавить выбранные занятия'; confirm.disabled = records.length === 0;
  confirm.addEventListener('click', () => {
    if (!profiles.accepts(ticket)) return;
    const ids = choices.filter(c => c.input.checked).map(c => c.id);
    if (!ids.length) { transferMessage('Выбери хотя бы одно занятие'); return; }
    const result = profiles.importGuest(ids, ticket);
    transferMessage(`Добавлено: ${result.added} · уже есть: ${result.same} · конфликты без замены: ${result.conflicts}`);
    guestImportPanel.hidden = true; refreshSyncUI(); void sync!.flush();
  });
  guestImportPanel.append(confirm);
});
exportButton.addEventListener('click', () => {
  try {
    const text = exportAggregates(store.data.history);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'neurohand-aggregates.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); transferMessage('Резервная копия истории скачана. Для чтения результатов используй отчёт PDF в итогах или истории.');
  } catch (e) { transferMessage(e instanceof Error ? e.message : 'Экспорт не выполнен'); }
});
importFile.addEventListener('change', async () => {
  const ticket = profiles.ticket(), file = importFile.files?.[0];
  if (!file || ticket.owner !== 'guest') return;
  try {
    if (file.size > MAX_TRANSFER_BYTES) throw Error('Файл превышает 5 MiB');
    const text = await file.text();
    if (!profiles.accepts(ticket)) return;
    const added = importAggregates(store, text); transferMessage(`Добавлено в историю этого браузера: ${added}. Для аккаунта выбери занятия отдельно.`); refreshSyncUI();
  } catch (e) { if (profiles.accepts(ticket)) transferMessage(e instanceof Error ? e.message : 'Импорт не выполнен'); }
  finally { importFile.value = ''; }
});
if (import.meta.hot) import.meta.hot.dispose(() => sync?.reset());

import { emptyOppositionState, restartOpposition, stepOppositionProgram, oppositionInstruction, type OppositionState } from './opposition-program';
import { settleOpposition } from './opposition';
import type { Calibration, BasicExerciseId, ExerciseId, Point, Reading } from "./types";
import type { HandGeometry } from "./geometry";
import { calibrate, DEFAULT_OPEN_CURL, readGrip, PINCH_CLOSE, GRIP_CLOSE_RATIO } from "./validator";
import { initialTimedFsm, stepTimed, stepHold, type TimedFsm, type HoldState, type Target } from "./fsm";
import { createSession, finishSession, pauseSession, recordActivity, recordRep, resumeSession, startExercise, type Session } from "./session";
import { closeActive, interruptAttempt } from './attempts';
import { emptyObserver, observeMovement, type AttemptObserver } from './attempt-observer';
import type { SuccessFeedback } from "./feedback";

export const PROGRAM_TIMING = { calibrationMs: 2000, minSamples: 20, readyMs: 1000, transitionMs: 3000, maxGapMs: 250, lostPauseMs: 2000 } as const;
export const EXERCISES: BasicExerciseId[] = ["pinch", "grip", "hold"];
export type ProgramPhase = "intro" | "preparing" | "exercise" | "transition" | "paused" | "summary";
export type PauseReason = "manual" | "results" | "visibility" | "tracking" | "camera";
type PromptState = { active: string | null; candidate: string | null; since: number | null; clearSince: number | null };
const emptyPrompt = (): PromptState => ({ active: null, candidate: null, since: null, clearSince: null });

export type Program = {
  attemptObserver: AttemptObserver; oppositionState: OppositionState;
  phase: ProgramPhase; session: Session; calibration: Calibration | null;
  pauseReason: PauseReason | null; fsm: TimedFsm; hold: HoldState;
  samples: HandGeometry[]; sampleSince: number | null; readySince: number | null;
  transitionSince: number | null; lastTimestamp: number | null; lastValidTimestamp: number | null;
  missingSince: number | null; wasActive: boolean; holdEligible: boolean; holdInterrupted: boolean;
  prompt: PromptState; reading: Reading | null; success: SuccessFeedback | null;
};
export type ProgramFrame = {
  timestampMs: number; wallTime: string; geometry: HandGeometry | null;
  pinch: Reading | null; fullHand: boolean; palm: Point | null; target: Target | null;
};

export function createProgram(session = createSession()): Program {
  return {
    oppositionState: emptyOppositionState(), attemptObserver: emptyObserver(), phase: "intro", session, calibration: null, pauseReason: null,
    fsm: initialTimedFsm(), hold: { holdMs: 0, reps: session.exercises.hold.reps },
    samples: [], sampleSince: null, readySince: null, transitionSince: null,
    lastTimestamp: null, lastValidTimestamp: null, missingSince: null, wasActive: false,
    holdEligible: false, holdInterrupted: false, prompt: emptyPrompt(), reading: null, success: null,
  };
}

function clearTransient(p: Program): Program {
  return { ...p, oppositionState: emptyOppositionState(), attemptObserver: emptyObserver(), fsm: initialTimedFsm(p.session.exercises[p.session.currentExercise]!.reps),
    hold: { holdMs: 0, reps: p.session.exercises.hold.reps }, samples: [], sampleSince: null,
    readySince: null, lastTimestamp: null, lastValidTimestamp: null, missingSince: null,
    wasActive: false, holdEligible: false, holdInterrupted: false, prompt: emptyPrompt(), reading: null, success: null };
}

export function beginProgram(p: Program, reason: "resize" | "pause" = "pause"): Program {
  if (p.session.status !== "in_progress") return p;
  if (p.session.mode === "opposition") return restartOpposition(p, reason);
  const currentExercise = EXERCISES.find(id => p.session.exercises[id]!.reps < p.session.exercises[id]!.target) ?? "hold";
  return clearTransient({ ...p, phase: "preparing", pauseReason: null,
    session: { ...resumeSession(p.session), attempts: closeActive(p.session.attempts, reason), currentExercise } });
}

export function pauseProgram(p: Program, reason: PauseReason, wallTime?: string): Program {
  if (p.session.status !== "in_progress") return p;
  const session = settleOpposition(pauseSession({ ...p.session, attempts: closeActive(p.session.attempts, p.missingSince !== null ? "tracking" : reason === "manual" ? "pause" : reason, wallTime) }));
  return clearTransient({ ...p, phase: session.status === 'completed' ? 'summary' : 'paused', pauseReason: reason, session });
}

export function stopProgram(p: Program, wallTime: string): Program {
  if (p.session.status !== "in_progress") return p;
  return clearTransient({ ...p, phase: "summary", session: finishSession({ ...p.session, attempts: closeActive(p.session.attempts, p.missingSince !== null ? "tracking" : "manual", wallTime) }, "stopped", wallTime) });
}

export function guidedTarget(width: number, height: number, completed: number, radiusRatio = 0.12): Target {
  const points = [[0.35, 0.5], [0.65, 0.45], [0.5, 0.65]];
  const [x, y] = points[Math.min(completed, 2)];
  return { x: x * width, y: y * height, r: Math.min(width, height) * radiusRatio };
}

function updatePrompt(state: PromptState, code: string | null, now: number): { state: PromptState; newCode?: string } {
  if (code) {
    if (code === state.active) return { state: { ...state, candidate: null, since: null, clearSince: null } };
    const since = state.candidate === code ? state.since ?? now : now;
    if (now - since >= 250) return { state: { active: code, candidate: null, since: null, clearSince: null }, newCode: code };
    return { state: { ...state, candidate: code, since, clearSince: null } };
  }
  const clearSince = state.clearSince ?? now;
  return { state: now - clearSince >= 300 ? emptyPrompt() : { ...state, candidate: null, since: null, clearSince } };
}

export function stepProgram(previous: Program, frame: ProgramFrame): Program {
  if (previous.session.mode === "opposition") return stepOppositionProgram(previous, frame);
  const now = frame.timestampMs;
  if (previous.session.status !== "in_progress" || previous.phase === "intro" || !Number.isFinite(now) ||
      (previous.lastTimestamp !== null && now <= previous.lastTimestamp)) return previous;
  const g = frame.fullHand ? frame.geometry : null;
  const grip = g ? readGrip(g, previous.calibration ?? { openCurl: DEFAULT_OPEN_CURL }, now) : null;
  const open = !!(g && grip?.open && frame.pinch?.open);
  if (previous.phase === "paused") {
    return previous.pauseReason === "tracking" && open ? beginProgram(previous) : previous;
  }
  let p: Program = { ...previous, lastTimestamp: now };
  const gap = previous.lastValidTimestamp === null ? 0 : now - previous.lastValidTimestamp;
  const contiguous = previous.lastValidTimestamp !== null && gap <= PROGRAM_TIMING.maxGapMs;
  if (p.session.attempts?.active && (!g || !contiguous)) {
    const first = previous.missingSince === null;
    const lostMs = previous.lastTimestamp === null ? 0 : now - previous.lastTimestamp;
    let attempts = interruptAttempt(p.session.attempts, lostMs, first);
    // A basic closure/continuous hold cannot be verified across a tracking gap.
    // Freeze until recovery or the tracking-pause threshold, then finalize once.
    if (g) attempts = closeActive(attempts, "tracking", frame.wallTime);
    p = { ...p, session: { ...p.session, attempts } };
  }
  if (!g || !contiguous) {
    p = { ...p, attemptObserver: emptyObserver(), fsm: initialTimedFsm(p.session.exercises[p.session.currentExercise]!.reps),
      hold: { ...p.hold, holdMs: 0 }, holdEligible: false, wasActive: false,
      holdInterrupted: p.holdInterrupted || p.hold.holdMs > 0,
      samples: [], sampleSince: null, readySince: null, success: null,
      prompt: { ...p.prompt, candidate: null, since: null, clearSince: null } };
  }
  if (!g) {
    const missingSince = p.missingSince ?? now;
    p = { ...p, missingSince, lastValidTimestamp: null, reading: null };
    return now - missingSince >= PROGRAM_TIMING.lostPauseMs ? pauseProgram(p, "tracking", frame.wallTime) : p;
  }
  p = { ...p, missingSince: null, lastValidTimestamp: now,
    reading: p.session.currentExercise === "pinch" ? frame.pinch : grip };
  if (p.phase === "preparing") {
    if (!open) return { ...p, samples: [], sampleSince: null, readySince: null };
    if (!p.calibration) {
      const samples = [...p.samples, g];
      const sampleSince = p.sampleSince ?? now;
      if (now - sampleSince < PROGRAM_TIMING.calibrationMs || samples.length < PROGRAM_TIMING.minSamples) return { ...p, samples, sampleSince };
      const calibration = calibrate(samples);
      if (!Number.isFinite(calibration.openCurl) || calibration.openCurl <= 0) return { ...p, samples: [], sampleSince: null };
      return { ...p, calibration, samples: [], sampleSince: null, readySince: now };
    }
    const readySince = p.readySince ?? now;
    if (now - readySince < PROGRAM_TIMING.readyMs) return { ...p, readySince };
    return { ...p, phase: "exercise", fsm: initialTimedFsm(p.session.exercises[p.session.currentExercise]!.reps), wasActive: false, readySince: null };
  }
  if (p.phase === "transition") {
    if (now - p.transitionSince! < PROGRAM_TIMING.transitionMs || !open) return p;
    const index = EXERCISES.indexOf(p.session.currentExercise as BasicExerciseId);
    const currentExercise = EXERCISES[index + 1];
    return { ...p, phase: "exercise", session: { ...p.session, currentExercise },
      fsm: initialTimedFsm(p.session.exercises[currentExercise]!.reps),
      attemptObserver: emptyObserver(), holdEligible: false, wasActive: false, success: null, prompt: emptyPrompt(), transitionSince: null };
  }
  if (p.phase !== "exercise") return p;
  const mode = p.session.currentExercise;
  let session = startExercise(p.session, mode);
  const dt = contiguous && previous.wasActive ? gap : 0;
  let action = session.exercises[mode]!.reps;
  let bestHold = p.hold.holdMs;
  if (mode === "hold") {
    const eligible = !!(grip?.open && frame.palm && frame.target &&
      Math.hypot(frame.palm.x - frame.target.x, frame.palm.y - frame.target.y) < frame.target.r);
    const hold = frame.target ? stepHold(p.hold, eligible ? frame.palm : null, frame.target, p.holdEligible && eligible ? dt : 0) : { ...p.hold, holdMs: 0 };
    bestHold = hold.reps > p.hold.reps ? session.settings.holdTargetMs : hold.holdMs;
    action = hold.reps;
    const holdInterrupted = hold.reps > p.hold.reps || hold.holdMs > 0 ? false : p.holdInterrupted || p.hold.holdMs > 0;
    p = { ...p, hold, holdInterrupted, holdEligible: eligible && hold.reps === p.hold.reps };
  } else {
    const fsm = stepTimed(p.fsm, p.reading, now);
    action = fsm.reps;
    p = { ...p, fsm };
  }
  const prompt = updatePrompt(p.prompt, p.reading?.error?.code ?? null, now);
  session = recordActivity(session, mode, dt, bestHold, prompt.newCode);
  let recorded = recordRep(session, { sessionId: session.id, exercise: mode, action });
  const confirmed = recorded !== session;
  const observed = observeMovement(recorded, p.attemptObserver, {
    now, wallTime: frame.wallTime, dt,
    ready: previous.fsm.phase === "ARMED", open: !!p.reading?.open, error: !!p.reading?.error,
    distance: mode === "hold" ? (frame.palm && frame.target ? Math.hypot(frame.palm.x - frame.target.x, frame.palm.y - frame.target.y) / frame.target.r : 0)
      : mode === "pinch" ? g.nd(4, 8) : Math.max(...[8, 12, 16, 20].map(t => g.curl(t))),
    successDistance: mode === "pinch" ? PINCH_CLOSE : p.calibration!.openCurl * GRIP_CLOSE_RATIO,
    holdMs: bestHold, confirmed,
  });
  recorded = observed.session;
  p = { ...p, attemptObserver: observed.observer, session: recorded, wasActive: true, prompt: prompt.state,
    success: p.reading?.error ? null : p.success };
  if (confirmed) {
    p.success = { exercise: mode, reps: action, at: now };
    if (action === session.exercises[mode]!.target) {
      if (mode === "hold") return { ...p, phase: "summary", wasActive: false,
        session: finishSession(recorded, "completed", frame.wallTime) };
      return { ...p, phase: "transition", transitionSince: now, wasActive: false, prompt: emptyPrompt() };
    }
  }
  return p;
}

export function programInstruction(p: Program, now: number): string {
  if (p.session.mode === "opposition") return oppositionInstruction(p);
  if (p.phase === "paused") return p.pauseReason === "tracking"
    ? "Рука потеряна. Покажи открытую ладонь для продолжения" : "Тренировка на паузе. Нажми «Продолжить»";
  if (p.phase === "preparing") {
    if (!p.calibration) return p.sampleSince === null ? "Покажи ладонь целиком и раскрой пальцы" : `Держи открытую ладонь · ${Math.min(2, (now - p.sampleSince) / 1000).toFixed(1)} / 2 с`;
    return p.readySince === null ? "Раскрой ладонь перед продолжением" : `Приготовься · ${Math.max(1, Math.ceil((PROGRAM_TIMING.readyMs - now + p.readySince) / 1000))}`;
  }
  if (p.phase === "transition") return `Задание завершено. Далее: ${p.session.currentExercise === "pinch" ? "5 сжатий" : "3 цели"}. Раскрой ладонь`;
  if (p.session.currentExercise === "pinch") return "Соедини большой и указательный пальцы";
  if (p.session.currentExercise === "grip") return "Раскрой кисть, затем сожми пальцы";
  if (p.reading && !p.reading.open) return "Раскрой ладонь, чтобы удерживать цель";
  return p.hold.holdMs > 0 ? `Удерживай · ${(p.hold.holdMs / 1000).toFixed(1)} / 2,0 с`
    : p.holdInterrupted ? "Верни ладонь в круг и начни удержание заново" : "Перемести открытую ладонь в круг";
}

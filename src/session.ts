import { createRuns } from './goals';
import { ringSettings, settleRing, type RingTip, type RingSettings } from './ring';
import { emptyAttempts, closeActive, type AttemptLog } from './attempts';
import { createOppositionPlan, settleOpposition, PAIR_RULES, type PairKey, type OppositionPlan } from './opposition';
import type { BasicExerciseId, ExerciseId } from "./types";

export const GUIDED_TARGETS = { pinch: 5, grip: 5, hold: 3 } as const;
export type ExerciseResult = {
  reps: number; target: number; started: boolean;
  activeMs: number; promptEpisodes: Record<string, number>; bestHoldMs: number | null;
};
export type Session = {
  schemaVersion: 3;
  attempts: AttemptLog | null;
  id: string;
  startedAt: string;
  endedAt: string | null;
  status: "in_progress" | "completed" | "stopped";
  mode: "guided" | "opposition" | "ring";
  ring?: RingSettings;
  opposition?: OppositionPlan;
  protocolId: "guided-v1" | "opposition-v1" | "ring-v1";
  recognitionVersion: string;
  hand: "left" | "right" | "unspecified";
  settings: { pinchTarget: number; gripTarget: number; holdTargetCount: number; holdTargetMs: number; targetRadiusRatio: number };
  currentExercise: ExerciseId;
  paused: boolean;
  exercises: Record<BasicExerciseId, ExerciseResult> & { opposition?: ExerciseResult; ring?: ExerciseResult };
};
export type RepConfirmed = {
  sessionId: string;
  exercise: ExerciseId;
  action: number;
};

export function createSession(id: string = crypto.randomUUID(), startedAt = new Date().toISOString()): Session {
  return {
    schemaVersion: 3, attempts: { ...emptyAttempts(), runs: createRuns([['pinch', 5], ['grip', 5], ['hold', 3]]) }, id, startedAt, endedAt: null, status: "in_progress", paused: false,
    mode: "guided", protocolId: "guided-v1", recognitionVersion: "landmarks-v1-norm008",
    hand: "unspecified", currentExercise: "pinch",
    settings: { pinchTarget: 5, gripTarget: 5, holdTargetCount: 3, holdTargetMs: 2000, targetRadiusRatio: 0.12 },
    exercises: {
      pinch: { reps: 0, target: 5, started: false, activeMs: 0, promptEpisodes: {}, bestHoldMs: null },
      grip: { reps: 0, target: 5, started: false, activeMs: 0, promptEpisodes: {}, bestHoldMs: null },
      hold: { reps: 0, target: 3, started: false, activeMs: 0, promptEpisodes: {}, bestHoldMs: 0 },
    },
  };
}

export function startExercise(session: Session, exercise: ExerciseId): Session {
  if (session.status !== "in_progress" || session.paused || !session.exercises[exercise] || session.exercises[exercise]!.started) return session;
  return { ...session, exercises: { ...session.exercises, [exercise]: { ...session.exercises[exercise], started: true } } };
}

/** The exercise action number is monotonic across tab changes and resumes. */
export function recordRep(session: Session, event: RepConfirmed): Session {
  if (session.status !== "in_progress" || session.paused || !session.exercises[event.exercise] || event.sessionId !== session.id ||
      event.action > session.exercises[event.exercise]!.target ||
      !Number.isSafeInteger(event.action) || event.action !== session.exercises[event.exercise]!.reps + 1) return session;
  return {
    ...session,
    exercises: { ...session.exercises, [event.exercise]: { ...session.exercises[event.exercise], reps: event.action, started: true } },
  };
}

export function pauseSession(session: Session): Session {
  return session.status !== "in_progress" || session.paused ? session : { ...session, paused: true };
}

export function resumeSession(session: Session): Session {
  return session.status === "in_progress" && session.paused ? { ...session, paused: false } : session;
}

export function recordActivity(session: Session, exercise: ExerciseId, dtMs: number, holdMs = 0, promptCode?: string): Session {
  if (session.paused || session.status !== "in_progress") return session;
  const result = session.exercises[exercise];
  if (!result) return session;
  return { ...session, exercises: { ...session.exercises, [exercise]: {
    ...result,
    activeMs: result.activeMs + (Number.isFinite(dtMs) && dtMs >= 0 && dtMs <= 250 ? dtMs : 0),
    bestHoldMs: exercise === "hold" ? Math.max(result.bestHoldMs ?? 0, Math.min(session.settings.holdTargetMs, holdMs)) : null,
    promptEpisodes: promptCode ? { ...result.promptEpisodes, [promptCode]: (result.promptEpisodes[promptCode] ?? 0) + 1 } : result.promptEpisodes,
  } } };
}

export function finishSession(session: Session, status: "completed" | "stopped", endedAt: string): Session {
  if (session.status !== "in_progress") return session;
  if (session.mode === "ring") {
    const settled = settleRing({ ...session, attempts: closeActive(session.attempts, "manual", endedAt) });
    return settled.status === "completed" ? settled : status === "completed" ? session : { ...settled, status, endedAt, paused: true };
  }
  if (session.mode === "opposition") {
    const settled = settleOpposition({ ...session, attempts: closeActive(session.attempts, 'manual', endedAt) });
    if (settled.status === 'completed') return settled;
    if (status === 'completed') return session;
    return { ...settled, status, endedAt, paused: true };
  }
  if (status === "completed" && !Object.values(session.exercises).every(result => result.reps === result.target)) return session;
  return { ...session, attempts: closeActive(session.attempts, 'manual', endedAt), status, endedAt, paused: true };
}

export function createOppositionSession(allowed: PairKey[], id: string = crypto.randomUUID(), startedAt = new Date().toISOString(), random = Math.random): Session {
  const base = createSession(id, startedAt), opposition = createOppositionPlan(allowed, random);
  return { ...base, mode: 'opposition', protocolId: 'opposition-v1', recognitionVersion: opposition.rulesVersion === 'mixed-pairs-v2' ? 'opposition-mixed-norm-v3' : PAIR_RULES.recognizerVersion,
    currentExercise: 'opposition', opposition, attempts: { ...emptyAttempts(), runs: createRuns([['opposition', opposition.sequence.length]]) }, exercises: { ...base.exercises,
      opposition: { reps: 0, target: opposition.sequence.length, started: false, activeMs: 0, promptEpisodes: {}, bestHoldMs: null } } };
}

export function createRingSession(tip: RingTip = 8, id: string = crypto.randomUUID(), startedAt = new Date().toISOString()): Session {
  const base = createSession(id, startedAt);
  return settleRing({ ...base, mode: 'ring', currentExercise: 'ring', protocolId: 'ring-v1', recognitionVersion: 'ring-screen-v1', ring: ringSettings(tip), attempts: { ...emptyAttempts(), runs: createRuns([['ring', 1]]) } });
}

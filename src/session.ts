import type { ExerciseId } from "./types";

export type ExerciseResult = { reps: number; started: boolean };
export type Session = {
  id: string;
  startedAt: string;
  paused: boolean;
  exercises: Record<ExerciseId, ExerciseResult>;
};
export type RepConfirmed = {
  sessionId: string;
  exercise: ExerciseId;
  action: number;
};

export function createSession(id = crypto.randomUUID(), startedAt = new Date().toISOString()): Session {
  return {
    id, startedAt, paused: false,
    exercises: {
      pinch: { reps: 0, started: false },
      grip: { reps: 0, started: false },
      hold: { reps: 0, started: false },
    },
  };
}

export function startExercise(session: Session, exercise: ExerciseId): Session {
  if (session.paused || session.exercises[exercise].started) return session;
  return { ...session, exercises: { ...session.exercises, [exercise]: { ...session.exercises[exercise], started: true } } };
}

/** The exercise action number is monotonic across tab changes and resumes. */
export function recordRep(session: Session, event: RepConfirmed): Session {
  if (session.paused || event.sessionId !== session.id ||
      !Number.isSafeInteger(event.action) || event.action !== session.exercises[event.exercise].reps + 1) return session;
  return {
    ...session,
    exercises: { ...session.exercises, [event.exercise]: { reps: event.action, started: true } },
  };
}

export function pauseSession(session: Session): Session {
  return session.paused ? session : { ...session, paused: true };
}

export function resumeSession(session: Session): Session {
  return session.paused ? { ...session, paused: false } : session;
}

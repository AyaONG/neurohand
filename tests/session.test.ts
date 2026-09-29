import { describe, expect, it } from "vitest";
import { createSession, pauseSession, recordRep, resumeSession, startExercise } from "../src/session";
import { getResults } from "../src/results";

describe("session results", () => {
  it("distinguishes an empty session, an attempted exercise and an untouched exercise", () => {
    const empty = createSession("s1", "2026-09-29T10:00:00Z");
    expect(getResults(empty).empty).toBe(true);
    const started = startExercise(empty, "pinch");
    expect(getResults(started)).toEqual({ empty: false, rows: [
      { exercise: "pinch", text: "Пинцет: 0 / 5" },
      { exercise: "grip", text: "Сжатия: Не начато" },
      { exercise: "hold", text: "Перенос: Не начато" },
    ] });
    expect(empty.exercises.pinch.started).toBe(false);
  });

  it("accepts one result per session/exercise/action and rejects duplicates or skipped actions", () => {
    const empty = createSession("s1");
    const event = { sessionId: "s1", exercise: "pinch" as const, action: 1 };
    const one = recordRep(empty, event);
    expect(one.exercises.pinch.reps).toBe(1);
    expect(recordRep(one, event)).toBe(one);
    expect(recordRep(one, { ...event, sessionId: "old", action: 2 })).toBe(one);
    for (const action of [0, 3, NaN, Infinity, 1.5]) expect(recordRep(one, { ...event, action })).toBe(one);
    expect(empty.exercises.pinch.reps).toBe(0);
  });

  it("preserves all modes and freezes result snapshots while paused", () => {
    let session = createSession("s1");
    for (let action = 1; action <= 3; action++) session = recordRep(session, { sessionId: "s1", exercise: "pinch", action });
    session = recordRep(session, { sessionId: "s1", exercise: "grip", action: 1 });
    const paused = pauseSession(session);
    const before = getResults(paused);
    for (let i = 0; i < 100; i++) {
      expect(recordRep(paused, { sessionId: "s1", exercise: "pinch", action: 4 })).toBe(paused);
      expect(startExercise(paused, "hold")).toBe(paused);
    }
    expect(pauseSession(paused)).toBe(paused);
    const continued = recordRep(resumeSession(paused), { sessionId: "s1", exercise: "pinch", action: 4 });
    expect(continued.exercises.pinch.reps).toBe(4);
    expect(continued.exercises.grip.reps).toBe(1);
    expect(getResults(paused)).toEqual(before);
    expect(paused.exercises.pinch.reps).toBe(3);
  });
});

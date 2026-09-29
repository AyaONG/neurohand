import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HandGeometry } from "../src/geometry";
import { readPinch } from "../src/validator";
import { beginProgram, createProgram, pauseProgram, stepProgram, stopProgram } from "../src/program";
import { createSession, finishSession, recordRep } from "../src/session";

const geometry = (name: string) => HandGeometry.create(JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")), 640, 480)!;
const open = geometry("grip_open");
const pinch = geometry("pinch_closed");
const fist = geometry("grip_closed");

function harness(dt = 20) {
  let p = beginProgram(createProgram(createSession("test-session", "2026-09-29T12:00:00Z")));
  let t = 0;
  const target = { x: 200, y: 200, r: 60 };
  function frame(g: HandGeometry | null = open, elapsed = dt, inside = true, fullHand = true) {
    t += elapsed;
    p = stepProgram(p, { timestampMs: t, wallTime: new Date(1_790_683_200_000 + t).toISOString(),
      geometry: g, fullHand, pinch: g ? readPinch(g, t) : null,
      palm: inside ? target : { x: 500, y: 500 }, target });
    return p;
  }
  function run(g: HandGeometry | null, ms: number, inside = true) {
    for (let elapsed = 0; elapsed < ms; elapsed += dt) frame(g, dt, inside);
    return p;
  }
  function rep(g: HandGeometry) { run(open, 240); run(g, 240); }
  function prepare() { run(open, 3400); expect(p.phase).toBe("exercise"); }
  function reachHold() {
    prepare();
    for (let i = 0; i < 5; i++) rep(pinch);
    run(open, 3300);
    expect(p.session.currentExercise).toBe("grip");
    for (let i = 0; i < 5; i++) rep(fist);
    run(open, 3300);
    expect(p.session.currentExercise).toBe("hold");
  }
  return { get p() { return p; }, set p(value) { p = value; }, get t() { return t; }, frame, run, rep, prepare, reachHold };
}

describe("guided-v1", () => {
  it("requires uninterrupted open-hand calibration and countdown, never uses empty fallback", () => {
    const h = harness();
    h.run(null, 3000);
    expect(h.p.calibration).toBeNull();
    expect(h.p.phase).toBe("paused");
    h.run(fist, 3000);
    expect(h.p.calibration).toBeNull();
    h.frame(open); // tracking pause resumes hands-free
    h.run(open, 1200);
    h.frame(null);
    expect(h.p.samples).toHaveLength(0);
    h.run(open, 1200);
    expect(h.p.calibration).toBeNull();
    h.frame(open, 20, true, false); // partially out of frame
    expect(h.p.samples).toHaveLength(0);
    h.run(open, 2100);
    expect(h.p.calibration?.openCurl).toBeGreaterThan(0);
    expect(h.p.phase).toBe("preparing");
    expect(h.p.session.exercises.pinch.reps).toBe(0);
    h.run(open, 1200);
    expect(h.p.phase).toBe("exercise");
  });

  it.each([16, 33, 50])("completes 5/5/3 once with %i ms observations", dt => {
    const h = harness(dt);
    h.reachHold();
    h.run(open, 6600);
    expect(h.p.phase).toBe("summary");
    expect(h.p.session.status).toBe("completed");
    expect(Object.values(h.p.session.exercises).map(e => e.reps)).toEqual([5, 5, 3]);
    expect(h.p.session.exercises.hold.bestHoldMs).toBe(2000);
    const final = h.p;
    h.run(open, 5000);
    expect(h.p).toBe(final);
    expect(stopProgram(final, "later")).toBe(final);
    expect(finishSession(final.session, "completed", "later")).toBe(final.session);
    expect(recordRep(final.session, { sessionId: final.session.id, exercise: "hold", action: 4 })).toBe(final.session);
    expect(final.session.endedAt).toMatch(/^\d{4}-/);
  });

  it("blocks closed gestures and counting during transitions, then waits for an open hand", () => {
    const h = harness(); h.prepare();
    for (let i = 0; i < 5; i++) h.rep(pinch);
    expect(h.p.phase).toBe("transition");
    const activeMs = h.p.session.exercises.pinch.activeMs;
    h.run(fist, 5000);
    expect(h.p.phase).toBe("transition");
    expect(h.p.session.exercises.pinch.activeMs).toBe(activeMs);
    expect(h.p.session.exercises.grip.reps).toBe(0);
    h.frame(open);
    expect(h.p.session.currentExercise).toBe("grip");
    h.run(fist, 1000);
    expect(h.p.session.exercises.grip.reps).toBe(0);
    h.rep(fist);
    expect(h.p.session.exercises.grip.reps).toBe(1);
  });

  it("preserves snapshots on manual pause/results and requires readiness on resume", () => {
    const h = harness(); h.prepare(); h.rep(pinch);
    h.p = pauseProgram(h.p, "results");
    const snapshot = h.p.session;
    h.run(open, 5000); h.rep(pinch);
    expect(h.p.session).toBe(snapshot);
    expect(snapshot.exercises.pinch.reps).toBe(1);
    h.p = beginProgram(h.p);
    h.run(pinch, 1000);
    expect(h.p.phase).toBe("preparing");
    h.run(open, 1200); h.rep(pinch);
    expect(h.p.session.exercises.pinch.reps).toBe(2);
    expect(snapshot.exercises.pinch.reps).toBe(1);
  });

  it("resets incomplete gestures across missing frames and long gaps", () => {
    const h = harness(); h.prepare(); h.run(open, 240);
    h.frame(pinch); h.frame(null); h.run(pinch, 1000);
    expect(h.p.session.exercises.pinch.reps).toBe(0);
    h.run(open, 240); h.frame(pinch, 1000); h.run(pinch, 1000);
    expect(h.p.session.exercises.pinch.reps).toBe(0);
    h.rep(pinch); expect(h.p.session.exercises.pinch.reps).toBe(1);
    h.run(null, 2200); expect(h.p.phase).toBe("paused");
    h.frame(open); expect(h.p.phase).toBe("preparing");
  });

  it("counts only continuous open-hand holding; loss, fist, exit and long gaps reset it", () => {
    const h = harness(); h.reachHold();
    h.run(fist, 2400); expect(h.p.hold.holdMs).toBe(0);
    h.run(open, 1000); expect(h.p.hold.holdMs).toBeGreaterThan(0);
    h.frame(open, 20, false); expect(h.p.hold.holdMs).toBe(0);
    h.run(open, 1000); h.frame(null); expect(h.p.hold.holdMs).toBe(0);
    h.run(open, 1000); h.frame(open, 1000); expect(h.p.hold.holdMs).toBe(0);
    expect(h.p.session.exercises.hold.reps).toBe(0);
    h.run(open, 1000); h.frame(fist); expect(h.p.hold.holdMs).toBe(0);
    const active = h.p.session.exercises.hold.activeMs;
    h.p = pauseProgram(h.p, "visibility"); h.frame(open, 10000);
    expect(h.p.session.exercises.hold.activeMs).toBe(active);
    h.p = beginProgram(h.p); h.run(open, 1200); h.run(open, 2100);
    expect(h.p.session.exercises.hold.reps).toBe(1);
  });

  it("counts stable prompt episodes rather than error frames, and missing hands are not correction", () => {
    const lm = JSON.parse(readFileSync(new URL("./fixtures/pinch_open.json", import.meta.url), "utf8"));
    lm[4] = { ...lm[12] };
    const wrong = HandGeometry.create(lm, 640, 480)!;
    const h = harness(); h.prepare();
    h.run(wrong, 200);
    expect(h.p.session.exercises.pinch.promptEpisodes.WRONG_FINGER).toBeUndefined();
    h.run(wrong, 2000);
    expect(h.p.session.exercises.pinch.promptEpisodes.WRONG_FINGER).toBe(1);
    const active = h.p.session.exercises.pinch.activeMs;
    h.run(null, 500);
    expect(h.p.session.exercises.pinch.activeMs).toBe(active);
    h.run(wrong, 600);
    expect(h.p.session.exercises.pinch.promptEpisodes.WRONG_FINGER).toBe(1);
    h.run(open, 400); h.run(wrong, 400);
    expect(h.p.session.exercises.pinch.promptEpisodes.WRONG_FINGER).toBe(2);
    expect(h.p.session.exercises.pinch.reps).toBe(0);
  });

  it("finishes early with stopped status and leaves prior records untouched on a new session", () => {
    const h = harness(); h.prepare(); h.rep(pinch);
    const stopped = stopProgram(h.p, "2026-09-29T13:00:00Z");
    expect(stopped.session.status).toBe("stopped");
    expect(stopped.session.exercises.pinch.reps).toBe(1);
    expect(finishSession(h.p.session, "completed", "now")).toBe(h.p.session);
    const next = createProgram();
    expect(next.session.id).not.toBe(stopped.session.id);
    expect(next.session.exercises.pinch.reps).toBe(0);
    expect(stopped.session.exercises.pinch.reps).toBe(1);
  });
});

const partialPinch = (() => {
  const lm = JSON.parse(readFileSync(new URL('./fixtures/grip_open.json', import.meta.url), 'utf8'));
  // Intentional closure between the existing open/close thresholds, away from other fingertips.
  lm[4].x = lm[8].x + (lm[4].x - lm[8].x) * 0.4 / open.nd(4, 8);
  lm[4].y = lm[8].y + (lm[4].y - lm[8].y) * 0.4 / open.nd(4, 8);
  return HandGeometry.create(lm, 640, 480)!;
})();

describe('attempt events alongside unchanged basic counters', () => {
  it('records five confirmed pinch attempts once, without counting static readiness', () => {
    const h = harness(); h.prepare(); h.run(open, 5000);
    expect(h.p.session.attempts?.records).toHaveLength(0);
    expect(h.p.session.attempts?.active).toBeNull();
    for (let i = 0; i < 5; i++) h.rep(pinch);
    expect(h.p.session.exercises.pinch.reps).toBe(5);
    expect(h.p.session.attempts?.records).toHaveLength(5);
    expect(h.p.session.attempts?.records.every(a => a.outcome === 'completed')).toBe(true);
    expect(new Set(h.p.session.attempts?.records.map(a => a.attemptId)).size).toBe(5);
  });

  it.each(['manual', 'results', 'visibility', 'camera'] as const)('handles %s without hidden time or repeated finalization', reason => {
    const h = harness(); h.prepare(); h.run(partialPinch, 400);
    const before = h.p.session.attempts?.active;
    expect(before).not.toBeNull();
    h.p = pauseProgram(h.p, reason, '2026-09-29T13:00:00Z');
    const once = h.p.session.attempts!.records[0];
    expect(once.activeMs).toBe(before!.activeMs);
    expect(once.outcome).toBe(reason === 'visibility' || reason === 'camera' ? 'unscorable' : 'partial');
    h.run(pinch, 10000); h.p = pauseProgram(h.p, reason);
    expect(h.p.session.attempts!.records).toEqual([once]);
    expect(h.p.session.exercises.pinch.reps).toBe(0);
    h.p = beginProgram(h.p); h.run(open, 1400); h.rep(pinch);
    expect(h.p.session.exercises.pinch.reps).toBe(1);
    expect(h.p.session.attempts!.records).toHaveLength(2);
    expect(h.p.session.attempts!.records[1].outcome).toBe('completed');
  });

  it('freezes a short loss, closes as unscorable on recovery, and requires a fresh open gesture', () => {
    const h = harness(); h.prepare(); h.run(partialPinch, 400);
    const before = h.p.session.attempts!.active!;
    h.run(null, 100);
    expect(h.p.session.attempts!.active?.activeMs).toBe(before.activeMs);
    h.run(pinch, 500);
    expect(h.p.session.exercises.pinch.reps).toBe(0);
    expect(h.p.session.attempts!.records).toHaveLength(1);
    expect(h.p.session.attempts!.records[0]).toMatchObject({ outcome: 'unscorable', endReason: 'tracking',
      activeMs: before.activeMs, interruptions: { count: 1, durationMs: 120 } });
    h.rep(pinch);
    expect(h.p.session.exercises.pinch.reps).toBe(1);
    expect(h.p.session.attempts!.records).toHaveLength(2);
  });

  it('long tracking loss pauses and never measures its gap as active time', () => {
    const h = harness(); h.prepare(); h.run(partialPinch, 400);
    const before = h.p.session.attempts!.active!;
    h.run(null, 3000);
    expect(h.p.phase).toBe('paused');
    expect(h.p.session.attempts!.records).toHaveLength(1);
    expect(h.p.session.attempts!.records[0]).toMatchObject({ outcome: 'unscorable', activeMs: before.activeMs });
    h.frame(open); h.run(open, 1400); h.rep(pinch);
    expect(h.p.session.attempts!.records).toHaveLength(2);
  });

  it('stops with measured partial work, leaves old counters alone, and resets on resize', () => {
    const h = harness(); h.prepare(); h.run(partialPinch, 400);
    const stopped = stopProgram(h.p, '2026-09-29T13:00:00Z');
    expect(stopped.session.status).toBe('stopped');
    expect(stopped.session.attempts!.records[0]).toMatchObject({ outcome: 'partial', endReason: 'manual' });
    expect(stopped.session.exercises.pinch.reps).toBe(0);
    const resized = beginProgram(h.p, 'resize');
    expect(resized.session.attempts!.records[0]).toMatchObject({ outcome: 'unscorable', endReason: 'resize' });
    expect(resized.attemptObserver.baseline).toBeNull();
  });
});

it('does not score a loss as partial when the user stops before tracking recovers', () => {
  const h = harness(); h.prepare(); h.run(partialPinch, 400); h.frame(null);
  const stopped = stopProgram(h.p, '2026-09-29T13:00:00Z');
  expect(stopped.session.attempts!.records[0]).toMatchObject({ outcome: 'unscorable', endReason: 'tracking' });
  const paused = pauseProgram(h.p, 'manual');
  expect(paused.session.attempts!.records[0].outcome).toBe('unscorable');
});

it('keeps the old static-hold counter but never fabricates a movement onset', () => {
  const h = harness(); h.reachHold();
  const before = h.p.session.attempts!.records.length;
  h.run(open, 6600); // Fixed synthetic target and unmoving palm: legacy hold detector still counts.
  expect(h.p.session.exercises.hold.reps).toBe(3);
  expect(h.p.session.attempts!.records.length).toBe(before);
});

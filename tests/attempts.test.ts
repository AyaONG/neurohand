import { describe, expect, it, vi } from 'vitest';
import { ATTEMPT_RULES, closeActive, emptyAttempts, finishAttempt, interruptAttempt, observeAttempt, startAttempt, attemptSummary, type Attempt } from '../src/attempts';
import { emptyObserver, observeMovement, type AttemptObservation } from '../src/attempt-observer';
import { createSession, finishSession } from '../src/session';
import { ProgressStore, STORAGE_KEY, V2_STORAGE_KEY, parseSession } from '../src/storage';

const wall = (ms: number) => new Date(Date.parse('2026-09-30T00:00:00Z') + ms).toISOString();
function attempt(): Attempt {
  return { attemptId: 'a', exerciseId: 'pinch', protocolVersion: 'guided-v1', recognizerVersion: 'landmarks-v1-norm008',
    rulesVersion: ATTEMPT_RULES.version, hand: 'left',
    settings: { target: 5, holdTargetMs: 2000, targetRadiusRatio: 0.12, maxActiveMs: 10000 },
    startedAt: wall(0), lastObservedAt: wall(0), endedAt: null, outcome: null, endReason: null,
    activeMs: 0, validTrackingMs: 0, interruptions: { count: 0, durationMs: 0 },
    metrics: { kind: 'closure', startDistance: 1, successDistance: 0.28, bestDistance: 1, progress: 0 } };
}
function activeSession() {
  const s = createSession('session', wall(0));
  delete s.attempts!.runs; // historical attempt without recorded goal associations
  s.attempts = startAttempt(s.attempts!, attempt());
  return s;
}
function memory() {
  const values = new Map<string, string>();
  return { values, getItem: (k: string) => values.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => { values.set(k, v); }) };
}
function movement(exercise: 'pinch' | 'hold' = 'pinch') {
  let session = createSession('move', wall(0)); session.currentExercise = exercise;
  let observer = emptyObserver(), t = 0;
  function frame(changes: Partial<AttemptObservation> = {}) {
    t += 20;
    const f: AttemptObservation = { now: t, wallTime: wall(t), dt: 20, ready: true, open: true,
      error: false, distance: 1, successDistance: 0.28, holdMs: 0, confirmed: false, ...changes };
    ({ session, observer } = observeMovement(session, observer, f));
    return session;
  }
  const run = (count: number, changes: Partial<AttemptObservation> = {}) => { for (let i = 0; i < count; i++) frame(changes); return session; };
  return { frame, run, get session() { return session; } };
}

describe('one terminal attempt per id', () => {
  it('rejects duplicate starts, stale observations and repeated/foreign finalization', () => {
    const log = startAttempt(emptyAttempts(), attempt());
    expect(startAttempt(log, { ...attempt(), attemptId: 'other' })).toBe(log);
    expect(finishAttempt(log, 'other', 'completed', 'confirmed', wall(200))).toBe(log);
    expect(finishAttempt(log, 'a', 'completed', 'timeout', wall(200))).toBe(log);
    const once = finishAttempt(log, 'a', 'completed', 'confirmed', wall(200));
    expect(once.records).toHaveLength(1);
    expect(finishAttempt(once, 'a', 'completed', 'confirmed', wall(300))).toBe(once);
    expect(observeAttempt(once, 'a', 20, wall(300), attempt().metrics)).toBe(once);
    expect(startAttempt(once, attempt())).toBe(once);
  });

  it('counts adjacent valid time only; interruptions do not add active time', () => {
    let log = startAttempt(emptyAttempts(), attempt());
    for (const dt of [-1, NaN, Infinity, 251, 10000]) expect(observeAttempt(log, 'a', dt, wall(20), attempt().metrics)).toBe(log);
    log = observeAttempt(log, 'a', 20, wall(20), attempt().metrics);
    expect(observeAttempt(log, 'a', 20, wall(0), attempt().metrics)).toBe(log);
    log = interruptAttempt(log, 2000, true)!;
    expect(log.active).toMatchObject({ activeMs: 20, validTrackingMs: 20, interruptions: { count: 1, durationMs: 2000 } });
    const closed = closeActive(log, 'tracking', wall(2020))!;
    expect(closed.records[0]).toMatchObject({ outcome: 'unscorable', endReason: 'tracking', activeMs: 20 });
  });

  it.each(['partial', 'incomplete', 'cancelled'] as const)('finishes manual observation as %s, never guesses success', outcome => {
    const a = attempt();
    a.activeMs = a.validTrackingMs = outcome === 'cancelled' ? 20 : 200;
    a.metrics.progress = outcome === 'partial' ? 1 : 0.05;
    const closed = closeActive(startAttempt(emptyAttempts(), a), 'manual', wall(500))!;
    expect(closed.records[0].outcome).toBe(outcome);
  });
});

describe('intent and noise gates', () => {
  it('does not create attempts for presence, small noise or a single outlier', () => {
    const h = movement(); h.run(100);
    h.frame({ distance: 0.1, open: false }); h.run(100);
    for (let i = 0; i < 100; i++) h.frame({ distance: 0.98 + (i % 2) * 0.04 });
    expect(h.session.attempts).toMatchObject(emptyAttempts());
  });

  it('requires readiness and reopening, and only a detector event produces completed', () => {
    const h = movement();
    h.run(50, { ready: false, open: false, distance: 0.1, confirmed: true });
    expect(h.session.attempts!.records).toHaveLength(0);
    h.run(10); h.run(20, { open: false, distance: 0.1 });
    expect(h.session.attempts!.active?.metrics.progress).toBe(1);
    expect(h.session.attempts!.records).toHaveLength(0);
    h.frame({ open: false, distance: 0.1, confirmed: true });
    const a = h.session.attempts!.records[0];
    expect(a.outcome).toBe('completed');
    h.run(100, { open: false, distance: 0.1, confirmed: true });
    expect(h.session.attempts!.records).toHaveLength(1);
    h.run(10); h.run(10, { open: false, distance: 0.1 });
    expect(h.session.attempts!.active?.attemptId).not.toBe(a.attemptId);
  });

  it('records a filtered partial closure on return, excluding an isolated best sample', () => {
    const h = movement(); h.run(10);
    h.run(10, { distance: 0.7, open: false });
    h.frame({ distance: 0.01, open: false });
    h.run(10, { distance: 0.7, open: false }); h.run(10);
    const a = h.session.attempts!.records[0];
    expect(a.outcome).toBe('partial'); expect(a.endReason).toBe('returned');
    expect(a.metrics.progress).toBeCloseTo(0.3 / 0.72);
    expect(a.metrics).not.toHaveProperty('samples');
  });

  it('does not split slow closure while the old detector still calls the pose open', () => {
    const h = movement(); h.run(10);
    h.run(30, { distance: 0.8, open: true });
    h.run(30, { distance: 0.6, open: true });
    expect(h.session.attempts!.records).toHaveLength(0);
    const id = h.session.attempts!.active!.attemptId;
    h.run(10, { distance: 0.2, open: false });
    h.frame({ distance: 0.2, open: false, confirmed: true });
    expect(h.session.attempts!.records).toHaveLength(1);
    expect(h.session.attempts!.records[0].attemptId).toBe(id);
  });

  it('times out once, requires reopening, and never increments a success counter', () => {
    const h = movement(); h.run(10); h.run(600, { distance: 0.7, open: false });
    expect(h.session.attempts!.records).toHaveLength(1);
    expect(h.session.attempts!.records[0]).toMatchObject({ endReason: 'timeout', outcome: 'partial', activeMs: 10000 });
    expect(h.session.attempts!.active).toBeNull();
    expect(h.session.exercises.pinch.reps).toBe(0);
  });

  it('does not turn stationary hand presence in a target into a movement attempt', () => {
    const h = movement('hold'); h.run(100, { holdMs: 1000 });
    expect(h.session.attempts!.active).toBeNull();
    h.run(10, { distance: 0.1, holdMs: 500 });
    expect(h.session.attempts!.active?.exerciseId).toBe('hold');
    h.run(10, { distance: 0.1, holdMs: 0 });
    expect(h.session.attempts!.records[0]).toMatchObject({ outcome: 'partial', metrics: { bestHoldMs: 500, progress: 0.25 } });
  });
});

describe('v2 migration and durable attempt results', () => {
  const v2 = () => { const { attempts, ...s } = createSession('old', wall(0)); return { ...s, schemaVersion: 2 }; };
  it('migrates actual v2 counters with unknown attempts and retains the exact original', () => {
    const m = memory(); const old = v2(); old.exercises.pinch.reps = 3; old.exercises.pinch.started = true;
    const raw = JSON.stringify({ schemaVersion: 2, current: old, history: [] }); m.values.set(V2_STORAGE_KEY, raw);
    const store = new ProgressStore(() => m);
    expect(store.data.current).toMatchObject({ schemaVersion: 3, attempts: null, paused: true, exercises: { pinch: { reps: 3 } } });
    expect(attemptSummary(store.data.current!.attempts)).toContain('не записывалось');
    expect(m.getItem(V2_STORAGE_KEY)).toBe(raw);
    expect(JSON.parse(m.getItem(STORAGE_KEY)!).schemaVersion).toBe(3);
    const restored = new ProgressStore(() => m);
    expect(restored.data.current?.exercises.pinch.reps).toBe(3);
  });

  it('never overwrites or drops a corrupt v2 source and never commits a partial migration', () => {
    const m = memory(); const old = { ...v2(), status: 'stopped', endedAt: wall(100) };
    const raw = JSON.stringify({ schemaVersion: 2, current: null, history: [old, { schemaVersion: 2, id: 'bad' }] });
    m.values.set(V2_STORAGE_KEY, raw);
    const store = new ProgressStore(() => m);
    expect(store.data.history).toHaveLength(1);
    store.save(finishSession(createSession('new', wall(0)), 'stopped', wall(200)), 200);
    expect(store.data.history).toHaveLength(2);
    expect(m.getItem(STORAGE_KEY)).toBeNull(); expect(m.getItem(V2_STORAGE_KEY)).toBe(raw);
  });

  it('preserves final v2 results and marks only newly observed attempts after resuming old data', () => {
    const m = memory(); const old = { ...v2(), status: 'stopped', endedAt: wall(100) };
    old.exercises.grip.started = true; old.exercises.grip.reps = 2;
    // Avoid intentionally reusing a final session id as a live one.
    const current = { ...v2(), id: 'resume' };
    m.values.set(V2_STORAGE_KEY, JSON.stringify({ schemaVersion: 2, current, history: [old] }));
    const store = new ProgressStore(() => m);
    expect(store.data.history[0]).toMatchObject({ attempts: null, exercises: { grip: { reps: 2 } } });
    let s = { ...store.data.current!, paused: false }, observer = emptyObserver();
    for (let t = 20; t <= 600; t += 20) {
      ({ session: s, observer } = observeMovement(s, observer, { now: t, dt: 20, wallTime: wall(t),
        distance: t < 300 ? 1 : 0.4, successDistance: 0.28, open: t < 300, ready: true, error: false, holdMs: 0, confirmed: false }));
    }
    expect(s.attempts?.historyComplete).toBe(false);
    expect(s.attempts?.active).not.toBeNull();
    expect(attemptSummary(s.attempts)).toContain('До обновления');
  });

  it('keeps v2 if migration write fails; corrupted v3 never silently falls back to stale v2', () => {
    const m = memory(); const raw = JSON.stringify({ schemaVersion: 2, current: v2(), history: [] });
    m.values.set(V2_STORAGE_KEY, raw); m.setItem.mockImplementation(() => { throw new Error('quota'); });
    const store = new ProgressStore(() => m);
    expect(store.data.current?.id).toBe('old'); expect(store.notice).toContain('не сохраняется');
    expect(m.getItem(V2_STORAGE_KEY)).toBe(raw);
    m.values.set(STORAGE_KEY, '{broken');
    expect(new ProgressStore(() => m).data.current).toBeNull();
  });

  it('saves attempt start/end immediately and finalizes an interrupted reload exactly once', () => {
    const m = memory(), store = new ProgressStore(() => m);
    store.save(createSession('session', wall(0)), 0);
    const active = activeSession(); store.save(active, 20);
    expect(m.setItem).toHaveBeenCalledTimes(2);
    const restored = new ProgressStore(() => m);
    const a = restored.data.current!.attempts!.records[0];
    expect(a).toMatchObject({ attemptId: 'a', outcome: 'unscorable', endReason: 'reload', activeMs: 0, endedAt: wall(0) });
    expect(restored.data.current?.attempts?.active).toBeNull();
    expect(new ProgressStore(() => m).data.current?.attempts?.records).toEqual([a]);
    expect(restored.data.current?.exercises.pinch.reps).toBe(0);
    const final = finishSession(restored.data.current!, 'stopped', wall(100));
    restored.save(final, 40); restored.save(final, 50);
    expect(new ProgressStore(() => m).data.history).toHaveLength(1);
  });

  it('rejects inconsistent/duplicate attempt ids and projects metrics without frame fields', () => {
    const s = activeSession();
    const dirty = JSON.parse(JSON.stringify(s));
    dirty.attempts.active.metrics.landmarks = [1, 2, 3];
    dirty.attempts.active.video = 'frame';
    expect(parseSession(dirty)?.attempts?.active?.metrics).not.toHaveProperty('landmarks');
    expect(parseSession(dirty)?.attempts?.active).not.toHaveProperty('video');
    for (const update of [{ activeMs: NaN }, { endedAt: wall(0) }, { outcome: 'completed' }]) {
      expect(parseSession({ ...s, attempts: { ...s.attempts, active: { ...s.attempts!.active, ...update } } })).toBeNull();
    }
    const log = closeActive(s.attempts, 'manual', wall(100))!;
    expect(parseSession({ ...s, attempts: { ...log, records: [log.records[0], log.records[0]] } })).toBeNull();
  });
});

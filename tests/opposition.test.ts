import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HandGeometry } from '../src/geometry';
import { readPinch, PINCH_CLOSE, PINCH_OPEN } from '../src/validator';
import { createOppositionPlan, currentPair, FINGER_TIPS, pairCounts, readOpposition, type FingerTip } from '../src/opposition';
import { createOppositionSession, createSession } from '../src/session';
import { beginProgram, createProgram, pauseProgram, stepProgram, stopProgram } from '../src/program';
import { finishOppositionAttempt, skipOppositionPair } from '../src/opposition-program';
import { parseSession, ProgressStore, STORAGE_KEY } from '../src/storage';
import { getResults } from '../src/results';

const base = JSON.parse(readFileSync(new URL('./fixtures/grip_open.json', import.meta.url), 'utf8'));
const wall = (t = 0) => new Date(Date.parse('2026-09-30T00:00:00Z') + t).toISOString();
function geometry(tip?: FingerTip, distance = 0.1, mirror = false, width = 640, height = 480, ambiguous = false) {
  const pixels = base.map((p: { x: number; y: number }) => ({ x: p.x * 640, y: p.y * 480, z: 0 }));
  if (tip) pixels[4] = { x: pixels[tip].x, y: pixels[tip].y + 100 * distance, z: 0 };
  if (ambiguous) pixels[tip === 8 ? 12 : 8] = { ...pixels[tip!] };
  return HandGeometry.create(pixels.map((p: { x: number; y: number; z: number }) => ({
    ...p, x: (mirror ? width - p.x : p.x) / width, y: p.y / height,
  })), width, height)!;
}
function harness(allowed: FingerTip[] = [12], mirror = false, dt = 20) {
  let p = beginProgram(createProgram(createOppositionSession(allowed, 'pairs', wall(), () => 0.999))), t = 0;
  p.session.hand = mirror ? 'left' : 'right';
  function frame(g: HandGeometry | null = geometry(undefined, 0, mirror), elapsed = dt) {
    t += elapsed;
    p = stepProgram(p, { timestampMs: t, wallTime: wall(t), geometry: g, fullHand: !!g,
      // Deliberately supply the OLD reading: a correct middle pair is WRONG_FINGER there.
      pinch: g ? readPinch(g, t) : null, palm: g?.palmCenter() ?? null, target: null });
    expect(parseSession(p.session), `session at ${t}ms`).not.toBeNull();
    return p;
  }
  function run(ms: number, g: HandGeometry | null = geometry(undefined, 0, mirror)) {
    for (let i = 0; i < ms; i += dt) frame(g);
    return p;
  }
  function prepare() { run(400); expect(p.phase).toBe('exercise'); }
  function close(ms = 600) { return run(ms, geometry(currentPair(p.session), 0.1, mirror)); }
  return { get p() { return p; }, set p(value) { p = value; }, get time() { return t; }, frame, run, prepare, close };
}
function memory() {
  const values = new Map<string, string>();
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
}

describe('selected thumb pairs', () => {
  it('builds exactly balanced shuffled blocks from only selected pairs', () => {
    for (const allowed of [[12], [8, 16], [...FINGER_TIPS]] as FingerTip[][]) {
      const a = createOppositionPlan(allowed, () => 0), b = createOppositionPlan(allowed, () => 0.999);
      expect(a.sequence).toHaveLength(allowed.length * 2);
      for (const tip of FINGER_TIPS) expect(a.sequence.filter(t => t === tip)).toHaveLength(allowed.includes(tip) ? 2 : 0);
      if (allowed.length > 1) expect(a.sequence).not.toEqual(b.sequence);
      expect(a.allowed).toEqual(allowed);
    }
    expect(() => createOppositionPlan([])).toThrow();
    expect(() => createOppositionPlan([4 as FingerTip])).toThrow();
  });

  it.each(FINGER_TIPS)('recognizes target %i on both sides and multiple canvas aspect ratios', tip => {
    for (const mirrored of [false, true]) for (const [w, h] of [[640, 480], [480, 640], [1280, 720]]) {
      const g = geometry(tip, 0.1, mirrored, w, h);
      expect(g.nd(4, tip)).toBeCloseTo(0.1);
      expect(readOpposition(g, tip)).toEqual({ open: false, closed: true, error: null });
      expect(readOpposition(geometry(undefined, 0, mirrored, w, h), tip).open).toBe(true);
    }
  });

  it('keeps the old index pinch thresholds/validator and rejects wrong or ambiguous pairs in the new mode', () => {
    expect(PINCH_CLOSE).toBe(0.28); expect(PINCH_OPEN).toBe(0.5);
    expect(readPinch(geometry(12), 100).error?.code).toBe('WRONG_FINGER');
    expect(readOpposition(geometry(12), 12).closed).toBe(true);
    expect(readOpposition(geometry(8), 12)).toMatchObject({ closed: false, error: { code: 'WRONG_FINGER' } });
    expect(readOpposition(geometry(12, 0.1, false, 640, 480, true), 12)).toMatchObject({ closed: false, error: { code: 'AMBIGUOUS_PAIR' } });
  });
});

describe('pair program and terminal attempts', () => {
  it.each([false, true])('fixes the target through holding/release and completes only selected pairs (mirror=%s)', mirror => {
    const h = harness([8, 12, 16, 20], mirror); h.prepare();
    const sequence = [...h.p.session.opposition!.sequence];
    for (let index = 0; index < sequence.length; index++) {
      expect(currentPair(h.p.session)).toBe(sequence[index]);
      h.close();
      expect(h.p.session.attempts!.records).toHaveLength(index + 1);
      expect(h.p.session.exercises.opposition!.reps).toBe(index + 1);
      h.close(2000);
      expect(h.p.session.attempts!.records).toHaveLength(index + 1);
      expect(currentPair(h.p.session)).toBe(sequence[index]);
      if (index < sequence.length - 1) { h.run(800); expect(h.p.phase).toBe('exercise'); }
    }
    expect(h.p.phase).toBe('summary'); expect(h.p.session.status).toBe('completed');
    expect(h.p.session.attempts!.records.map(a => a.settings.pairTip)).toEqual(sequence);
    expect(h.p.session.attempts!.records.every(a => a.outcome === 'completed')).toBe(true);
    const final = h.p; h.run(5000); expect(h.p).toBe(final);
  });

  it.each([33, 100, 250])('confirms and releases at %i ms observations without replaying held gestures', dt => {
    const h = harness([16], false, dt); h.prepare(); h.close(1000);
    expect(pairCounts(h.p.session).completed).toBe(1);
    h.close(3000); expect(pairCounts(h.p.session).completed).toBe(1);
    h.run(1500); h.close(1000);
    expect(h.p.session.status).toBe('completed');
    expect(h.p.session.attempts!.records).toHaveLength(2);
  });

  it('does not award for another pair, ambiguity, noise or a single close outlier', () => {
    const h = harness(); h.prepare();
    h.run(3000, geometry(8)); expect(h.p.session.exercises.opposition!.reps).toBe(0);
    expect(h.p.reading?.error?.message).toContain('средний');
    h.run(3000, geometry(12, 0.1, false, 640, 480, true));
    expect(h.p.session.exercises.opposition!.reps).toBe(0);
    h.run(400); h.frame(geometry(12)); h.run(1000);
    expect(h.p.session.attempts!.records).toHaveLength(1);
    expect(h.p.session.attempts!.records[0].outcome).toBe('incomplete');
    expect(h.p.session.attempts!.active).toBeNull();
    h.close(); expect(h.p.session.exercises.opposition!.reps).toBe(1);
  });

  it('keeps a filtered partial below an outlier and retries the same goal', () => {
    const h = harness(); h.prepare();
    h.run(400, geometry(12, 0.4));
    const progress = h.p.session.attempts!.active!.metrics.progress;
    h.frame(geometry(12, 0.01)); h.run(200, geometry(12, 0.4));
    expect(h.p.session.attempts!.active!.metrics.progress).toBeCloseTo(progress);
    h.p = finishOppositionAttempt(h.p, wall(h.time));
    const once = h.p; h.p = finishOppositionAttempt(h.p, wall(h.time)); expect(h.p).toBe(once);
    expect(h.p.session.attempts!.records[0].outcome).toBe('partial');
    h.run(800); h.run(400, geometry(12, 0.4));
    h.p = finishOppositionAttempt(h.p, wall(h.time));
    expect(h.p.session.status).toBe('in_progress');
    expect(pairCounts(h.p.session)).toMatchObject({ completed: 0, partial: 2, consumed: 0 });
    expect(h.p.session.opposition!.cursor).toBe(0);
    expect(getResults(h.p.session).rows[0].text).toContain('0 / 2');
    expect(parseSession(h.p.session)).not.toBeNull();
  });

  it('times out using valid active time, never as completed; repeated held frames do not consume more slots', () => {
    const h = harness(); h.prepare(); h.run(11000, geometry(12, 0.4));
    expect(h.p.session.attempts!.records).toHaveLength(1);
    expect(h.p.session.attempts!.records[0]).toMatchObject({ outcome: 'partial', endReason: 'timeout', activeMs: 10000 });
    h.run(15000, geometry(12, 0.4));
    expect(h.p.session.attempts!.records).toHaveLength(1);
    expect(h.p.session.opposition!.cursor).toBe(0);
    expect(h.p.session.exercises.opposition!.reps).toBe(0);
  });

  it('freezes a tracking gap, retries the same slot after reopening, and ignores stale frames', () => {
    const h = harness(); h.prepare(); h.run(400, geometry(12, 0.4));
    const before = h.p.session.attempts!.active!;
    h.run(100, null); expect(h.p.session.attempts!.active!.activeMs).toBe(before.activeMs);
    h.close(1000);
    expect(h.p.session.attempts!.records[0]).toMatchObject({ outcome: 'unscorable', endReason: 'tracking', activeMs: before.activeMs, interruptions: { count: 1, durationMs: 120 } });
    expect(h.p.session.opposition!.cursor).toBe(0);
    expect(h.p.session.attempts!.active).toBeNull();
    const saved = h.p; h.frame(geometry(), 0); expect(h.p).toBe(saved);
    h.run(400); h.close();
    expect(pairCounts(h.p.session)).toMatchObject({ unscorable: 1, completed: 1, consumed: 1 });
  });

  it('a long gap or lost tracking cannot bridge closure and pauses after two seconds', () => {
    const h = harness(); h.prepare(); h.run(400, geometry(12, 0.4));
    h.frame(geometry(12), 1000); h.close();
    expect(h.p.session.attempts!.records[0].outcome).toBe('unscorable');
    expect(pairCounts(h.p.session).completed).toBe(0);
    h.run(400); h.run(400, geometry(12, 0.4)); h.run(3000, null);
    expect(h.p.phase).toBe('paused'); expect(h.p.pauseReason).toBe('tracking');
    expect(pairCounts(h.p.session)).toMatchObject({ consumed: 0, unscorable: 2 });
    h.run(1000); h.close(); expect(pairCounts(h.p.session).completed).toBe(1);
  });

  it('manual pause stores measured work, visibility is unscorable, and neither adds paused time', () => {
    const h = harness(); h.prepare(); h.run(400, geometry(12, 0.4));
    const activeMs = h.p.session.attempts!.active!.activeMs;
    h.p = pauseProgram(h.p, 'visibility', wall(h.time)); h.run(5000);
    expect(h.p.session.attempts!.records[0]).toMatchObject({ outcome: 'unscorable', endReason: 'visibility', activeMs });
    h.p = beginProgram(h.p); h.run(400); h.run(400, geometry(12, 0.4));
    h.p = pauseProgram(h.p, 'manual', wall(h.time));
    expect(h.p.session.attempts!.records[1].outcome).toBe('partial');
    expect(h.p.session.opposition!.awaitingRelease).toBe(false);
    h.p = beginProgram(h.p); h.close(2000); expect(h.p.session.opposition!.cursor).toBe(0);
    h.run(800); expect(h.p.session.opposition!.cursor).toBe(0);
  });

  it('skips only before an active movement, does not invent metrics, and stays paused when skipping on pause', () => {
    const h = harness(); h.prepare();
    h.p = pauseProgram(h.p, 'manual'); h.p = skipOppositionPair(h.p, wall(h.time));
    expect(h.p.phase).toBe('paused');
    expect(h.p.session.attempts!.records[0]).toMatchObject({ outcome: 'cancelled', endReason: 'skip', metrics: { kind: 'skipped', progress: 0 } });
    h.p = beginProgram(h.p); h.run(800); h.run(400, geometry(12, 0.4));
    const active = h.p; h.p = skipOppositionPair(h.p, wall(h.time)); expect(h.p).toBe(active);
    h.p = finishOppositionAttempt(h.p, wall(h.time));
    expect(h.p.session.status).toBe('in_progress');
    expect(pairCounts(h.p.session)).toMatchObject({ skipped: 1, partial: 1, completed: 0 });
  });
});

describe('pair persistence', () => {
  it('restores a frozen target after active reload, and preserves release gating after a completed slot', () => {
    const m = memory(), store = new ProgressStore(() => m), h = harness([12, 20]);
    h.prepare(); h.run(400, geometry(12, 0.4)); store.save(h.p.session, h.time, true);
    const sequence = h.p.session.opposition!.sequence;
    const restored = new ProgressStore(() => m);
    expect(restored.data.current!.attempts!.records[0].endReason).toBe('reload');
    expect(restored.data.current!.opposition!.sequence).toEqual(sequence);
    h.p = beginProgram(createProgram(restored.data.current!)); h.close();
    expect(pairCounts(h.p.session).consumed).toBe(0);
    h.run(400); h.close(); restored.save(h.p.session, h.time, true);
    const again = new ProgressStore(() => m);
    expect(again.data.current!.opposition).toMatchObject({ cursor: 0, awaitingRelease: true });
    h.p = beginProgram(createProgram(again.data.current!)); h.close(2000);
    expect(currentPair(h.p.session)).toBe(12);
    h.run(800); expect(currentPair(h.p.session)).toBe(20);
    const snapshot = h.p.session; again.save(snapshot, h.time, true);
    expect(JSON.parse(m.getItem(STORAGE_KEY)!).current.opposition.cursor).toBe(1);
  });

  it('validates sequence/settings, deduplicates final sessions and leaves old guided records readable', () => {
    const h = harness(); h.prepare(); h.p = skipOppositionPair(h.p, wall(h.time)); h.run(800);
    h.p = skipOppositionPair(h.p, wall(h.time));
    expect(parseSession(h.p.session)).not.toBeNull();
    const dirty = JSON.parse(JSON.stringify(h.p.session)); dirty.opposition.sequence[0] = 16;
    expect(parseSession(dirty)).toBeNull();
    const mixed = JSON.parse(JSON.stringify(h.p.session)); mixed.attempts.records[0].settings.pairTip = 8;
    expect(parseSession(mixed)).toBeNull();
    const m = memory(), store = new ProgressStore(() => m);
    store.save(h.p.session, 0); store.save(h.p.session, 1, true);
    expect(new ProgressStore(() => m).data.history).toHaveLength(1);
    expect(parseSession(createSession('old', wall()))).not.toBeNull();
    const stopped = stopProgram(beginProgram(createProgram(createOppositionSession([8]))), new Date().toISOString());
    expect(parseSession(stopped.session)?.status).toBe('stopped');
  });
});

it('one goal: two observed wrong-pair returns then success; three evaluated attempts survive reload', async () => {
  const { goalRows, successText, currentGoalText } = await import('../src/goals');
  const h = harness(); h.prepare();
  for (let n = 0; n < 2; n++) {
    h.run(700, geometry(8));
    h.run(800);
    expect(h.p.session.opposition!.cursor).toBe(0);
    expect(h.p.session.attempts!.records[n].outcome).toBe('incomplete');
    expect(h.p.session.attempts!.active).toBeNull();
  }
  expect(currentGoalText(h.p.session)).toContain('Цель 1 из 2 · Попытка 3');
  const baseline = geometry().nd(4, 12);
  for (let n = 0; n < 80; n++) h.frame(geometry(12, baseline - (baseline - 0.1) * n / 79));
  h.close(600);
  const records = h.p.session.attempts!.records;
  expect(records.map(a => a.outcome)).toEqual(['incomplete', 'incomplete', 'completed']);
  expect(new Set(records.map(a => a.goalId)).size).toBe(1);
  expect(records.map(a => a.attemptOrder)).toEqual([1, 2, 3]);
  expect(records[2].activeMs).toBeGreaterThan(1000);
  expect(successText(goalRows(h.p.session.attempts)![0].toSuccess)).toBe('Выполнено с третьей попытки');
  h.close(2000); expect(h.p.session.attempts!.records).toHaveLength(3);
  const m = memory(); new ProgressStore(() => m).save(h.p.session, h.time, true);
  const restored = new ProgressStore(() => m).data.current!;
  expect(goalRows(restored.attempts)![0]).toMatchObject({ completed: true, toSuccess: 3 });
  expect(restored.exercises.opposition!.reps).toBe(1);
});

it('excludes tracking interruptions and skips from attempts to success and validates goal links', async () => {
  const { goalRows } = await import('../src/goals');
  const h = harness(); h.prepare(); h.run(600, geometry(12, 0.4));
  h.run(100, null); h.run(800);
  expect(h.p.session.attempts!.records[0].outcome).toBe('unscorable');
  h.close();
  expect(goalRows(h.p.session.attempts)![0]).toMatchObject({ completed: true, toSuccess: 1 });
  const broken = structuredClone(h.p.session);
  broken.attempts!.records[1].goalId = 'foreign';
  expect(parseSession(broken)).toBeNull();
  h.run(800); h.p = skipOppositionPair(h.p, wall(h.time));
  expect(goalRows(h.p.session.attempts)![1]).toMatchObject({ completed: false, toSuccess: null });
});

it('preserves historical finals without inventing run/goal associations or changing their payload', () => {
  const h = harness(); h.prepare(); h.close(); h.run(800); h.close();
  const old = structuredClone(h.p.session);
  delete old.attempts!.runs;
  for (const a of old.attempts!.records) {
    delete a.exerciseRunId; delete a.goalId; delete a.attemptOrder;
  }
  const m = memory();
  m.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 3, history: [old], current: null }));
  const raw = m.getItem(STORAGE_KEY);
  const loaded = new ProgressStore(() => m);
  expect(loaded.data.history[0]).toEqual(old);
  expect(m.getItem(STORAGE_KEY)).toBe(raw);
  expect(loaded.data.history[0].attempts!.runs).toBeUndefined();
});

it('two sub-threshold target excursions end incomplete, then complete the SAME goal on the third attempt', async () => {
  const { goalRows } = await import('../src/goals');
  const h = harness(); h.prepare();
  const start = geometry().nd(4,12), distance = start - 0.15 * (start - 0.26);
  for (let i=0;i<2;i++) { h.run(600, geometry(12, distance)); h.run(800); }
  expect(h.p.session.attempts!.records.map(a => a.outcome)).toEqual(['incomplete','incomplete']);
  h.close();
  expect(goalRows(h.p.session.attempts)![0]).toMatchObject({ completed:true, toSuccess:3 });
  expect(h.p.session.exercises.opposition!.reps).toBe(1);
});

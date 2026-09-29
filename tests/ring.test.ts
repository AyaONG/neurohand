import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { createRingSession } from '../src/session';
import { beginProgram, createProgram, pauseProgram, stepProgram } from '../src/program';
import { finishRingAttempt } from '../src/ring-program';
import { HandGeometry } from '../src/geometry';
import { markAngle, ringLayout, ringPoint, screenPoint, RING_TIPS, type RingTip } from '../src/ring';
import { parseSession, ProgressStore, STORAGE_KEY } from '../src/storage';
import { getResults } from '../src/results';
const lm = JSON.parse(readFileSync(new URL('./fixtures/grip_open.json', import.meta.url), 'utf8'));
const wall = (t: number) => new Date(Date.parse('2026-09-30T00:00:00Z') + t).toISOString();
function harness(tip: RingTip = 8, width = 640, height = 480, dt = 50) {
  let p = beginProgram(createProgram(createRingSession(tip, 'ring', wall(0)))), t = 0;
  function frame(angle: number | null, radius = 1, elapsed = dt, w = width, h = height) {
    t += elapsed;
    const ring = ringLayout(w, h), point = angle === null ? null : ringPoint({ ...ring, r: ring.r * radius }, angle);
    p = stepProgram(p, { timestampMs: t, wallTime: wall(t), fullHand: !!point, geometry: point ? HandGeometry.create(lm, w, h) : null,
      pinch: null, palm: null, target: null, ring: { width: w, height: h, point } });
    expect(parseSession(p.session), `parse at ${t}`).not.toBeNull();
    return p;
  }
  function ready() { for (let i = 0; i <= Math.ceil(600 / dt); i++) frame(0); expect(p.ringState.ready).toBe(true); }
  function path(until = Math.PI * 2) { for (let angle = 0.025; angle <= until + 0.00001; angle += 0.025) frame(angle); return p; }
  return { get p() { return p; }, set p(value) { p = value; }, get t() { return t; }, frame, ready, path };
}
it.each(RING_TIPS)('completes exactly once with selected tip %i, all marks and return', tip => {
  for (const [w, h] of [[640, 480], [480, 640], [1280, 720]]) {
    const a = harness(tip, w, h, 20); a.ready(); a.path(); a.frame(2 * Math.PI);
    expect(a.p.phase).toBe('summary');
    const records = a.p.session.attempts!.records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'completed', endReason: 'confirmed', settings: { ring: { tip } }, metrics: { marks: 12, returned: true, progress: 1 } });
    expect(records[0].activeMs).toBeGreaterThan(4000);
    a.path(); expect(a.p.session.attempts!.records).toHaveLength(1);
  }
});
it('preserves 8/12 on manual finish and reports a partial route without a full circle', () => {
  const a = harness(); a.ready(); a.path(markAngle(7) + 0.05);
  a.p = finishRingAttempt(a.p, wall(a.t));
  expect(a.p.session.status).toBe('completed');
  expect(a.p.session.exercises.ring!.reps).toBe(0);
  expect(a.p.session.attempts!.records[0]).toMatchObject({ outcome: 'partial', metrics: { marks: 8, returned: false } });
  expect(getResults(a.p.session).rows[0].text).toContain('8 / 12');
  expect(parseSession(a.p.session)).not.toBeNull();
});
it('requires return even after the twelfth mark', () => {
  const a = harness(8, 640, 480, 20); a.ready(); a.path(markAngle(11) + 0.03);
  expect(a.p.session.attempts!.active?.metrics).toMatchObject({ marks: 12, returned: false });
  a.p = finishRingAttempt(a.p, wall(a.t));
  expect(a.p.session.attempts!.records[0].outcome).toBe('partial');
});
it('stationary presence, initial movement without readiness, and start oscillation cannot produce a circle', () => {
  const a = harness(); a.path(); expect(a.p.session.attempts!.records).toHaveLength(0);
  a.ready(); for (let i = 0; i < 300; i++) a.frame(i % 2 ? 0.04 : -0.04);
  expect(a.p.session.attempts!.active).toBeNull(); expect(a.p.session.attempts!.records).toHaveLength(0);
});
it('rejects reverse direction, a center shortcut, and a single frame jump', () => {
  const reverse = harness(); reverse.ready(); for (let x = 0; x > -6.3; x -= 0.05) reverse.frame(x);
  expect(reverse.p.session.exercises.ring!.reps).toBe(0);
  for (const failure of ['center', 'jump'] as const) {
    const a = harness(); a.ready(); a.path(1.6); const before = a.p.session.attempts!.active!;
    a.frame(failure === 'jump' ? 4 : 1.6, failure === 'center' ? 0 : 1);
    expect(a.p.session.attempts!.active).toBeNull();
    const result = a.p.session.attempts!.records[0];
    expect(result.outcome).not.toBe('completed'); expect(result.metrics).toEqual(before.metrics);
    a.frame(2 * Math.PI); expect(a.p.session.exercises.ring!.reps).toBe(0);
  }
});
it('tracking gaps never bridge the path, including no-frame gaps', () => {
  for (const loss of ['null', 'gap']) {
    const a = harness(); a.ready(); a.path(2);
    if (loss === 'null') a.frame(null, 1, 50); else a.frame(3, 1, 1000);
    expect(a.p.session.attempts!.records[0]).toMatchObject({ outcome: 'unscorable', endReason: 'tracking' });
    a.frame(2 * Math.PI); expect(a.p.session.exercises.ring!.reps).toBe(0);
    a.ready(); a.path(); expect(a.p.session.exercises.ring!.reps).toBe(1);
  }
});
it('pause, visibility, resize and reload retain aggregates without resuming the old segment', () => {
  for (const reason of ['pause', 'visibility', 'resize', 'reload'] as const) {
    const a = harness(); a.ready(); a.path(2);
    const old = a.p.session.attempts!.active!;
    if (reason === 'resize') a.frame(2, 1, 50, 1280, 720);
    else if (reason === 'reload') {
      const values = new Map<string, string>();
      const memory = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
      const store = new ProgressStore(() => memory); store.save(a.p.session, a.t, true);
      expect(values.get(STORAGE_KEY)).not.toMatch(/landmarks|trajectory|previous|travel/);
      const restored = new ProgressStore(() => memory); a.p = createProgram(restored.data.current!);
      expect(new ProgressStore(() => memory).data.current!.attempts!.records).toHaveLength(1);
    } else a.p = pauseProgram(a.p, reason === 'pause' ? 'manual' : reason, wall(a.t));
    const record = a.p.session.attempts!.records[0];
    expect(record.metrics).toEqual(old.metrics); expect(record.activeMs).toBe(old.activeMs);
    expect(record.endReason).toBe(reason);
    expect(record.outcome).toBe(reason === 'pause' ? 'partial' : 'unscorable');
    a.p = beginProgram(a.p); a.frame(2 * Math.PI);
    expect(a.p.session.attempts!.active).toBeNull();
  }
});
it('times out a begun but unfinished attempt without forcing full success', () => {
  const a = harness(); a.ready(); a.path(1);
  for (let i = 0; i < 310; i++) a.frame(1);
  expect(a.p.session.status).toBe('completed');
  expect(a.p.session.attempts!.records[0]).toMatchObject({ outcome: 'partial', endReason: 'timeout' });
});
it('projects only allowed settings and metrics, rejecting false full success', () => {
  const a = harness(20); a.ready(); a.path(2); a.p = finishRingAttempt(a.p, wall(a.t));
  const session = JSON.parse(JSON.stringify(a.p.session));
  session.ring.landmarks = lm; session.attempts.records[0].metrics.trajectory = lm;
  expect(JSON.stringify(parseSession(session))).not.toMatch(/landmarks|trajectory/);
  session.attempts.records[0].outcome = 'completed'; session.attempts.records[0].endReason = 'confirmed';
  expect(parseSession(session)).toBeNull();
});
it('uses identical mirrored source-aspect coordinates at all uniform viewport scales', () => {
  for (const [w, h] of [[640, 480], [1280, 720], [480, 640]]) for (const scale of [0.4, 1, 2]) {
    const p = { x: 0.2, y: 0.7 };
    const actual = screenPoint(p, w * scale, h * scale), reference = screenPoint(p, w, h);
    expect(actual.x).toBeCloseTo(reference.x * scale); expect(actual.y).toBeCloseTo(reference.y * scale);
    expect(ringLayout(w * scale, h * scale).r).toBeCloseTo(ringLayout(w, h).r * scale);
  }
});
it.each([33, 100, 250])('accepts a continuous path at %i ms frames, starting within either edge of the start zone', dt => {
  for (const offset of [-0.06, 0.06]) {
    const a = harness(8, 640, 480, dt);
    for (let i = 0; i < 20; i++) a.frame(offset);
    for (let angle = offset + 0.8 * dt / 1000; angle < 2 * Math.PI; angle += 0.8 * dt / 1000) a.frame(angle);
    a.frame(2 * Math.PI);
    expect(a.p.session.attempts!.records[0]).toMatchObject({ outcome: 'completed', metrics: { marks: 12, returned: true } });
  }
});
it('aligns checkpoint thresholds with visible marks even when readiness was off the exact start center', () => {
  const a = harness(8, 640, 480, 20);
  for (let i = 0; i < 40; i++) a.frame(-0.06);
  for (let x = -0.04; x < markAngle(0) - 0.02; x += 0.02) a.frame(x);
  expect(a.p.session.attempts!.active?.metrics).toMatchObject({ marks: 0 });
  a.frame(markAngle(0) + 0.001);
  expect(a.p.session.attempts!.active?.metrics).toMatchObject({ marks: 1 });
});

import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { HandGeometry } from '../src/geometry';
import { ALL_PAIR_KEYS, EXTRA_PAIR_KEYS, pairOf, pairRules, readOpposition, createOppositionPlan, type PairKey } from '../src/opposition';
import { createOppositionSession } from '../src/session';
import { beginProgram, createProgram, stepProgram } from '../src/program';
import { finishOppositionAttempt } from '../src/opposition-program';
import { parseSession, ProgressStore } from '../src/storage';
import { goalRows } from '../src/goals';
const base = JSON.parse(readFileSync(new URL('./fixtures/grip_open.json', import.meta.url), 'utf8'));
const wall = (t: number) => new Date(Date.parse('2026-09-30T00:00:00Z') + t).toISOString();
function pose(key?: PairKey, distance = 0.08, mirror = false, depth = 0) {
  const lm = structuredClone(base);
  if (key) {
    const [a,b] = pairOf(key);
    lm[a] = { x: lm[b].x, y: lm[b].y + distance * 100 / 480, z: depth };
  }
  if (mirror) for (const p of lm) p.x = 1 - p.x;
  return HandGeometry.create(lm, 640, 480)!;
}
function harness(key: PairKey, mirror = false) {
  let p = beginProgram(createProgram(createOppositionSession([key], 'free-pairs', wall(0)))), t = 0;
  const frame = (g: HandGeometry | null) => {
    t += 20;
    p = stepProgram(p, { timestampMs:t, wallTime:wall(t), geometry:g, fullHand:!!g, pinch:null, palm:g?.palmCenter() ?? null, target:null });
    expect(parseSession(p.session), `at ${t}`).not.toBeNull();
  };
  const run = (ms: number, g: HandGeometry | null = pose(undefined, 0, mirror)) => { for (let n=0;n<ms;n+=20) frame(g); };
  return { run, get p() { return p; }, set p(v) { p=v; }, get time() { return t; } };
}
it('catalog contains exactly ten unique two-tip pairs; only explicitly selected entries enter the plan', () => {
  expect(ALL_PAIR_KEYS).toHaveLength(10);
  expect(new Set(ALL_PAIR_KEYS.map(k => pairOf(k).join('-'))).size).toBe(10);
  const plan = createOppositionPlan([12, '8-16'], () => 0.5);
  expect(plan.sequence).toHaveLength(4);
  expect(plan.sequence.every(k => k === 12 || k === '8-16')).toBe(true);
  expect(createOppositionPlan([8]).sequence).toEqual([8,8]);
});
it.each(EXTRA_PAIR_KEYS)('recognizes manually selected %s on both sides, requires release and persists pair settings', key => {
  for (const mirror of [false,true]) {
    const h = harness(key, mirror);
    h.run(1000, pose(key, 0.08, mirror));
    expect(h.p.session.attempts!.active).toBeNull();
    h.run(500); h.run(800, pose(key, 0.08, mirror));
    expect(h.p.session.exercises.opposition!.reps).toBe(1);
    expect(h.p.session.attempts!.records[0].settings).toMatchObject({ pair: pairOf(key), pairRule: 'free-pairs-v1' });
    h.run(2000, pose(key, 0.08, mirror));
    expect(h.p.session.attempts!.records).toHaveLength(1);
    h.run(800); h.run(800, pose(key, 0.08, mirror));
    expect(h.p.session.status).toBe('completed');
    const memory = new Map<string,string>();
    const storage = { getItem:(k:string)=>memory.get(k)??null, setItem:(k:string,v:string)=>{memory.set(k,v);} };
    new ProgressStore(()=>storage).save(h.p.session, h.time, true);
    expect(new ProgressStore(()=>storage).data.history[0]).toEqual(h.p.session);
  }
});
it('rejects overlap, depth-separated projections and third-finger ambiguity without requiring other fingers straight', () => {
  expect(readOpposition(pose('8-12', 0), '8-12').error?.code).toBe('AMBIGUOUS_PAIR');
  expect(readOpposition(pose('8-12', 0.08, false, 0.2), '8-12').closed).toBe(false);
  const lm = structuredClone(base);
  lm[8] = { ...lm[12], y: lm[12].y + 8/480 };
  lm[16] = { ...lm[12] };
  expect(readOpposition(HandGeometry.create(lm,640,480)!, '8-12').closed).toBe(false);
  // Unrelated ring/little tips may rest together far from the requested pair.
  lm[16] = { x:0.6, y:0.6, z:0 }; lm[20] = { ...lm[16] };
  expect(readOpposition(HandGeometry.create(lm,640,480)!, '8-12').closed).toBe(true);
});
it('wrong pair is measured once, cannot succeed, and must return before a timed-out held gesture can retry', () => {
  const h = harness('8-12'); h.run(500);
  h.run(11000, pose('16-20'));
  expect(h.p.session.attempts!.records).toHaveLength(1);
  expect(h.p.session.attempts!.records[0].outcome).toBe('incomplete');
  h.run(12000, pose('16-20')); expect(h.p.session.attempts!.records).toHaveLength(1);
  h.run(800); h.run(600, pose('16-20')); h.run(800);
  expect(h.p.session.attempts!.records).toHaveLength(2);
  h.run(800, pose('8-12'));
  expect(goalRows(h.p.session.attempts)![0].toSuccess).toBe(3);
});
it('retains partial progress on the same pair, rejects stationary noise, and marks a tracking interruption separately', () => {
  const h = harness('8-12'); h.run(2000);
  expect(h.p.session.attempts!.records).toHaveLength(0);
  h.run(600, pose('8-12', 0.2));
  h.p = finishOppositionAttempt(h.p, wall(h.time));
  expect(h.p.session.attempts!.records[0].outcome).toBe('partial');
  expect(h.p.session.opposition!.cursor).toBe(0);
  h.run(800); h.run(600, pose('8-12', 0.2)); h.run(100,null); h.run(800);
  expect(h.p.session.attempts!.records[1].outcome).toBe('unscorable');
  h.run(800, pose('8-12'));
  expect(goalRows(h.p.session.attempts)![0].toSuccess).toBe(2);
  expect(pairRules('8-12').close).not.toBe(pairRules(8).close);
});

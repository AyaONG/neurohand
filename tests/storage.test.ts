import { describe, expect, it, vi } from 'vitest';
import { ProgressStore, STORAGE_KEY, LEGACY_KEY, parseSession, comparable, MEMORY_NOTICE } from '../src/storage';
import { createSession, finishSession, recordRep, recordActivity } from '../src/session';
import { activity, comparison, localDay } from '../src/history';
import { beginProgram, createProgram, stepProgram } from '../src/program';

function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
}
function session(id = 'one') { return createSession(id, '2026-09-29T10:00:00Z'); }
function complete(id = 'one', end = '2026-09-29T10:01:00Z') {
  const s = session(id); s.hand = 'left';
  for (const r of Object.values(s.exercises)) { r.started = true; r.reps = r.target; }
  return finishSession(s, 'completed', end);
}

describe('versioned local progress', () => {
  it('atomically moves the current record into history and deduplicates immutable final snapshots', () => {
    const memory = memoryStorage(), store = new ProgressStore(() => memory);
    store.save(session(), 0);
    expect(JSON.parse(memory.getItem(STORAGE_KEY)!).current.id).toBe('one');
    store.save(complete(), 1);
    store.save(complete(), 2, true);
    store.save(session(), 3, true);
    expect(store.data.current).toBeNull();
    expect(store.data.history).toHaveLength(1);
    expect(memory.setItem).toHaveBeenCalledTimes(2);
    store.save(session('two'), 4);
    const restored = new ProgressStore(() => memory);
    expect(restored.data.current?.id).toBe('two');
    expect(restored.data.current?.paused).toBe(true);
    expect(restored.data.history[0].id).toBe('one');
  });

  it('retains only the newest 30 completed or stopped sessions', () => {
    const store = new ProgressStore(() => memoryStorage());
    for (let i = 0; i < 35; i++) store.save(complete(String(i), new Date(Date.parse('2026-09-29T11:00:00Z') + i * 1000).toISOString()), i);
    store.save(finishSession(session('stop'), 'stopped', '2026-09-29T12:00:00Z'), 40);
    expect(store.data.history).toHaveLength(30);
    expect(store.data.history[0].id).toBe('stop');
    expect(store.data.history.at(-1)?.id).toBe('6');
  });

  it('checkpoints time at 2s, writes events immediately and omits extra fields', () => {
    const memory = memoryStorage(), store = new ProgressStore(() => memory);
    let s = session(); s.exercises.pinch.started = true;
    store.save(s, 0);
    for (let t = 20; t < 2000; t += 20) { s = recordActivity(s, 'pinch', 20); store.save(s, t); }
    expect(memory.setItem).toHaveBeenCalledTimes(1);
    store.save(s, 2000); expect(memory.setItem).toHaveBeenCalledTimes(2);
    s = recordRep(s, { sessionId: s.id, exercise: 'pinch', action: 1 });
    store.save({ ...s, landmarks: [{ x: 1 }] } as typeof s, 2020);
    s = recordActivity(s, 'pinch', 20, 0, 'WRONG_FINGER'); store.save(s, 2040);
    expect(memory.setItem).toHaveBeenCalledTimes(4);
    expect(JSON.parse(memory.getItem(STORAGE_KEY)!).current).not.toHaveProperty('landmarks');
    expect(new ProgressStore(() => memory).data.current?.exercises.pinch.promptEpisodes.WRONG_FINGER).toBe(1);
  });

  it('recovers counts with a fresh gesture/calibration clock, never elapsed wall time', () => {
    const memory = memoryStorage(), store = new ProgressStore(() => memory);
    const s = recordRep(session(), { sessionId: 'one', exercise: 'pinch', action: 1 });
    store.save(s, 100);
    const restored = new ProgressStore(() => memory).data.current!;
    let p = beginProgram(createProgram(restored));
    expect(p.calibration).toBeNull(); expect(p.hold.holdMs).toBe(0); expect(p.lastTimestamp).toBeNull();
    p = stepProgram(p, { timestampMs: 9999999, wallTime: '2026-09-30T12:00:00Z', geometry: null, pinch: null, fullHand: false, palm: null, target: null });
    expect(p.session.exercises.pinch.reps).toBe(1);
    expect(p.session.exercises.pinch.activeMs).toBe(0);
    expect(p.hold.holdMs).toBe(0);
  });

  it('continues in memory when storage access or writes throw', () => {
    const denied = new ProgressStore(() => { throw new Error('SecurityError'); });
    denied.save(complete(), 0);
    expect(denied.data.history).toHaveLength(1); expect(denied.notice).toContain(MEMORY_NOTICE);
    const memory = memoryStorage(); memory.setItem.mockImplementation(() => { throw new Error('quota'); });
    const quota = new ProgressStore(() => memory); quota.save(complete(), 0); quota.save(complete('two'), 1);
    expect(quota.data.history).toHaveLength(2); expect(quota.notice).toBe(MEMORY_NOTICE);
  });

  it('salvages valid records without overwriting corrupted source data', () => {
    const memory = memoryStorage();
    const raw = JSON.stringify({ schemaVersion: 2, current: null, history: [complete(), { ...complete('bad'), exercises: {} }] });
    memory.values.set(STORAGE_KEY, raw);
    const store = new ProgressStore(() => memory);
    expect(store.data.history).toHaveLength(1); expect(store.notice).toContain('повреждены');
    store.save(complete('new'), 0);
    expect(store.data.history).toHaveLength(2); expect(memory.getItem(STORAGE_KEY)).toBe(raw);
    memory.values.set(STORAGE_KEY, '{broken');
    expect(() => new ProgressStore(() => memory)).not.toThrow();
  });

  it.each([NaN, Infinity, -1, 1.5])('rejects invalid repetition counter %s', reps => {
    const s = session(); s.exercises.pinch.reps = reps;
    expect(parseSession(s)).toBeNull();
  });

  it('keeps known old counters separate with unknown dates/settings, preserving the original', () => {
    const memory = memoryStorage(); const raw = JSON.stringify({ pinch: { reps: 3 }, grip: { reps: 2 }, hold: { reps: -1 } });
    memory.values.set(LEGACY_KEY, raw);
    const store = new ProgressStore(() => memory);
    expect(store.legacy).toEqual({ kind: 'legacy', counters: { pinch: 3, grip: 2 } });
    expect(store.data.history).toEqual([]); store.save(complete(), 0);
    expect(memory.getItem(LEGACY_KEY)).toBe(raw);
    memory.values.set(LEGACY_KEY, '{bad');
    expect(new ProgressStore(() => memory).notice).toContain('Старая запись');
  });
});

describe('progress comparisons and local calendar', () => {
  it('compares only two completed sessions with the same explicit hand and settings', () => {
    const a = complete('old'), b = complete('new', '2026-09-29T12:00:00Z');
    expect(comparable(a, b)).toBe(true);
    for (const change of [{ hand: 'right' }, { hand: 'unspecified' }, { recognitionVersion: 'changed' }, { protocolId: 'other' }, { status: 'stopped' }]) {
      expect(comparable(a, { ...b, ...change } as typeof b)).toBe(false);
    }
    for (const key of Object.keys(b.settings) as (keyof typeof b.settings)[]) {
      expect(comparable(a, { ...b, settings: { ...b.settings, [key]: b.settings[key] + 1 } })).toBe(false);
    }
    expect(comparison([a, b])).toEqual([a, b]);
    expect(comparison([a])).toBeNull();
  });

  it('uses seven local dates across a month boundary, marking partial days separately', () => {
    const now = new Date(2026, 9, 2, 0, 5);
    const a = complete(); a.endedAt = new Date(2026, 9, 1, 23, 59).toISOString();
    const b = { ...complete('partial'), status: 'stopped' as const, endedAt: new Date(2026, 9, 2, 0, 1).toISOString() };
    const days = activity([a, b], now);
    expect(days.map(d => d.day)).toEqual(['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(days[5].completed).toBe(1); expect(days[6].partial).toBe(1); expect(days[6].completed).toBe(0);
    expect(localDay(now)).toBe('2026-10-02');
  });
});


it('deduplicates loaded ids and keeps a final record over stale current data', () => {
  const memory = memoryStorage();
  memory.values.set(STORAGE_KEY, JSON.stringify({ schemaVersion: 2, current: session(), history: [complete(), complete()] }));
  const store = new ProgressStore(() => memory);
  expect(store.data.history).toHaveLength(1); expect(store.data.current).toBeNull();
});

it('can stop an interrupted session immediately without adding time or actions', () => {
  const memory = memoryStorage(), store = new ProgressStore(() => memory);
  const before = recordRep(session(), { sessionId: 'one', exercise: 'pinch', action: 1 });
  store.save(before, 0);
  const restored = new ProgressStore(() => memory);
  restored.save(finishSession(restored.data.current!, 'stopped', '2026-10-01T10:00:00Z'), 0);
  expect(restored.data.current).toBeNull();
  expect(restored.data.history[0].exercises).toEqual(before.exercises);
});

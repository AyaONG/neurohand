import { expect, it } from 'vitest';
import { createOppositionSession, createRingSession, createSession, type Session } from '../src/session';
import { attemptCounts, attemptDetail, attemptText, comparableResults, defaultFilter, filterHistory, metricText, ringMetric } from '../src/progress';
import type { Attempt } from '../src/attempts';
import { settleRing } from '../src/ring';
import { settleOpposition } from '../src/opposition';
import { parseSession, ProgressStore, STORAGE_KEY } from '../src/storage';
const wall = '2026-09-30T01:00:00.000Z';
function attempt(s: Session, outcome: Attempt['outcome'], marks = 8, reason: Attempt['endReason'] = 'manual'): Attempt {
  return { attemptId: crypto.randomUUID(), exerciseId: s.currentExercise, protocolVersion: s.protocolId, recognizerVersion: s.recognitionVersion,
    rulesVersion: 'ring-v1', hand: s.hand, settings: { target: 1, holdTargetMs: 2000, targetRadiusRatio: 0.12, maxActiveMs: 15000, ring: s.ring },
    startedAt: wall, lastObservedAt: wall, endedAt: wall, outcome, endReason: reason, activeMs: 5000, validTrackingMs: 5000,
    interruptions: { count: 0, durationMs: 0 }, metrics: { kind: 'ring', marks, returned: outcome === 'completed', pathLength: 5, progress: marks / 12 } };
}
function ring(id: string, marks = 8) {
  let s = createRingSession(8, id, wall); s.hand = 'left';
  s.attempts!.records = [attempt(s, marks === 12 ? 'completed' : 'partial', marks, marks === 12 ? 'confirmed' : 'manual')];
  return settleRing(s);
}
it('separates final session status from full/partial attempts and unscorable observations', () => {
  const s = ring('partial');
  s.attempts!.records.unshift(attempt(s, 'unscorable', 11, 'tracking'));
  const settled = settleRing(s);
  expect(parseSession(settled)).not.toBeNull();
  expect(settled.status).toBe('completed'); expect(settled.exercises.ring!.reps).toBe(0);
  expect(attemptCounts(settled)).toMatchObject({ evaluated: 1, partial: 1, completed: 0, unscorable: 1 });
  expect(ringMetric(settled)).toContain('Лучший оценённый путь: 8 / 12');
  expect(ringMetric(settled)).toContain('При сбоях наблюдалось до 11 / 12');
  expect(attemptDetail(settled.attempts!.records[0])).toContain('потеря руки');
});
it('keeps skips and cancellation outside evaluated attempts, and reports pair metrics', () => {
  const s = createOppositionSession([12], 'pairs', wall); s.hand = 'left';
  const skipped: Attempt = { ...attempt(s, 'cancelled', 0, 'skip'), exerciseId: 'opposition', rulesVersion: 'opposition-v1',
    settings: { target: 2, holdTargetMs: 2000, targetRadiusRatio: 0.12, maxActiveMs: 10000, partialRatio: 0.2, pairTip: 12, sequenceIndex: 0 },
    metrics: { kind: 'skipped', progress: 0 }, activeMs: 0, validTrackingMs: 0 };
  const partial: Attempt = { ...skipped, attemptId: 'partial', settings: { ...skipped.settings, sequenceIndex: 1 },
    outcome: 'partial', endReason: 'manual', activeMs: 1000, validTrackingMs: 1000,
    metrics: { kind: 'closure', startDistance: 1, bestDistance: 0.6, successDistance: 0.26, progress: 0.5 } };
  s.opposition!.cursor = 1; s.attempts!.records = [skipped, partial];
  const final = settleOpposition(s);
  expect(parseSession(final)).not.toBeNull();
  expect(attemptCounts(final)).toMatchObject({ skipped: 1, cancelled: 0, evaluated: 1, partial: 1 });
  expect(metricText(final)).toContain('Пары: 0/2 полностью');
  expect(attemptDetail(skipped)).toContain('Пропущено'); expect(attemptDetail(partial)).toContain('средний');
  expect(attemptDetail(partial)).toContain('1.00 → 0.60');
});
it('does not turn legacy successes into attempts or compare unknown rules', () => {
  const s = createSession('old', wall); s.hand = 'left'; s.attempts = null;
  s.exercises.pinch = { ...s.exercises.pinch, started: true, reps: 3 };
  expect(attemptCounts(s).known).toBe(false); expect(attemptText(s)).toContain('не записывалось');
  expect(metricText(s, 'pinch')).toContain('3/5'); expect(comparableResults(s, s)).toBe(false);
  s.attempts = { historyComplete: false, active: null, records: [] };
  expect(attemptText(s)).toContain('До обновления попытки неизвестны');
});
it('filters exercise, hand and recorded conditions without changing stored rows', () => {
  const a = ring('a'), b = ring('b', 12), right = { ...ring('right'), hand: 'right' as const };
  const other = createSession('guided', wall); const history = [a, b, right, other];
  expect(filterHistory(history, { ...defaultFilter(), exercise: 'ring', hand: 'left' }).map(s => s.id)).toEqual(['a', 'b']);
  expect(filterHistory(history, { ...defaultFilter(), exercise: 'hold' })).toEqual([other]);
  expect(filterHistory(history, { ...defaultFilter(), exercise: 'opposition' })).toEqual([]);
  expect(filterHistory(history, { ...defaultFilter(), seriesId: 'a' }).map(s => s.id)).toEqual(['a', 'b']);
  expect(history).toHaveLength(4);
});
it('requires identical rules, recognizer, hand, fingertip, corridor, limits and targets for comparisons', () => {
  const a = ring('a'), b = ring('b', 12); expect(comparableResults(a, b)).toBe(true);
  const changed = (edit: (s: Session) => void) => { const s = structuredClone(b); edit(s); expect(comparableResults(a, s)).toBe(false); };
  changed(s => { s.ring!.tip = 20; }); changed(s => { s.ring!.corridorRatio = 0.2; });
  changed(s => { s.ring!.maxActiveMs = 20000; }); changed(s => { s.ring!.rulesVersion = 'v2'; });
  changed(s => { s.recognitionVersion = 'v2'; }); changed(s => { s.hand = 'unspecified'; });
  changed(s => { s.attempts!.records[0].rulesVersion = 'other'; });
  changed(s => { s.attempts!.records[0].settings.maxActiveMs = 30000; });
  changed(s => { s.attempts!.records[0].settings.target = 2; });
  expect(comparableResults(a, b, 'pinch')).toBe(false);
});
it('keeps zero evaluated attempts explicit when every observation is unscorable', () => {
  const s = createRingSession(8, 'failed', wall); s.attempts!.records = [attempt(s, 'unscorable', 10, 'jump')];
  expect(ringMetric(s)).toContain('Недостаточно данных'); expect(attemptText(s)).toContain('Оценено: 0');
  expect(attemptText(s)).toContain('не удалось оценить: 1');
});
it('preserves all local records on quota failure and deduplicates after reload without truncation', () => {
  let raw = ''; let fail = false;
  const memory = { getItem: (key: string) => key === STORAGE_KEY && raw ? raw : null, setItem: (_: string, value: string) => { if (fail) throw Error('quota'); raw = value; } };
  const store = new ProgressStore(() => memory);
  for (let i = 0; i < 65; i++) store.save(ring(String(i)), i, true);
  fail = true; store.save(ring('unsaved'), 66, true);
  expect(store.data.history).toHaveLength(66); expect(store.notice).toContain('не сохраняется');
  const loaded = new ProgressStore(() => memory); expect(loaded.data.history).toHaveLength(65);
  loaded.save(ring('0'), 70, true); expect(loaded.data.history).toHaveLength(65);
  expect(loaded.data.history.every(s => parseSession(s))).toBe(true);
});

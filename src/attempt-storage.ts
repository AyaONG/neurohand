import { parseRingSettings } from './ring';
import { isPairKey, pairOf, pairRules, PAIR_RULES, type FingerPair } from './opposition';
import type { Attempt, AttemptLog, AttemptMetrics } from './attempts';

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const count = (v: unknown): v is number => number(v) && Number.isSafeInteger(v);
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** Strict projection: neither arbitrary metrics nor frame/landmark fields reach storage. */
function parseAttempt(v: unknown, active: boolean): Attempt | null {
  if (!object(v) || !text(v.attemptId) || !['pinch', 'grip', 'hold', 'opposition', 'ring'].includes(v.exerciseId) ||
      !text(v.protocolVersion) || !text(v.recognizerVersion) || !text(v.rulesVersion) ||
      !['left', 'right', 'unspecified'].includes(v.hand) || !date(v.startedAt) || !date(v.lastObservedAt) ||
      Date.parse(v.lastObservedAt) < Date.parse(v.startedAt) || !number(v.activeMs) || !number(v.validTrackingMs) ||
      v.activeMs > v.validTrackingMs || !object(v.interruptions) || !count(v.interruptions.count) ||
      !number(v.interruptions.durationMs) || !object(v.settings) || !object(v.metrics)) return null;
  if (active ? v.outcome !== null || v.endedAt !== null || v.endReason !== null
    : !['completed', 'partial', 'incomplete', 'unscorable', 'cancelled'].includes(v.outcome) ||
      !['confirmed', 'returned', 'manual', 'pause', 'results', 'visibility', 'tracking', 'camera', 'reload', 'resize', 'timeout', 'skip', 'off_path', 'jump'].includes(v.endReason) ||
      !date(v.endedAt) || Date.parse(v.endedAt) < Date.parse(v.lastObservedAt)) return null;
  if ((v.outcome === 'completed') !== (v.endReason === 'confirmed')) return null;
  const linked = v.goalId !== undefined || v.exerciseRunId !== undefined || v.attemptOrder !== undefined;
  if (linked && (!text(v.goalId) || !text(v.exerciseRunId) || !count(v.attemptOrder) || v.attemptOrder < 1)) return null;
  const s = v.settings, m = v.metrics;
  if (!count(s.target) || s.target === 0 || !number(s.holdTargetMs) || s.holdTargetMs === 0 ||
      !number(s.targetRadiusRatio) || s.targetRadiusRatio === 0 || s.targetRadiusRatio > 1 ||
      !number(s.maxActiveMs) || s.maxActiveMs === 0 || !number(m.progress) || m.progress > 1) return null;
  const pair = v.exerciseId === 'opposition';
  if (pair && (!isPairKey(s.pairTip) || !count(s.sequenceIndex) || s.partialRatio !== PAIR_RULES.partialRatio ||
      s.maxActiveMs !== PAIR_RULES.maxActiveMs || v.rulesVersion !== pairRules(s.pairTip).version)) return null;
  if (pair && s.pair !== undefined && (!Array.isArray(s.pair) || JSON.stringify(s.pair) !== JSON.stringify(pairOf(s.pairTip)) ||
      s.pairRule !== pairRules(s.pairTip).version)) return null;
  if (pair && typeof s.pairTip === 'string' && s.pair === undefined) return null;
  if (s.movementPair !== undefined || s.movementStartDistance !== undefined) {
    if (!pair || !Array.isArray(s.movementPair) || s.movementPair.length !== 2 || s.movementPair[0] >= s.movementPair[1] ||
        !s.movementPair.every((t: unknown) => [4,8,12,16,20].includes(t as number)) || !number(s.movementStartDistance)) return null;
  }
  if (v.endReason === 'skip' && (!pair || v.outcome !== 'cancelled' || m.kind !== 'skipped')) return null;
  const ring = v.exerciseId === 'ring' ? parseRingSettings(s.ring) : null;
  if (v.exerciseId === 'ring' && (!ring || v.rulesVersion !== ring.rulesVersion || s.maxActiveMs !== ring.maxActiveMs || s.target !== 1)) return null;
  let metrics: AttemptMetrics;
  if (ring) {
    if (m.kind !== 'ring' || !count(m.marks) || m.marks > 12 || typeof m.returned !== 'boolean' || !number(m.pathLength) || m.progress !== m.marks / 12 ||
        (m.returned && m.marks !== 12) || ((v.outcome === 'completed') !== m.returned)) return null;
    metrics = { kind: 'ring', marks: m.marks, returned: m.returned, pathLength: m.pathLength, progress: m.progress };
  } else if (m.kind === 'skipped') {
    if (!pair || active || v.endReason !== 'skip' || m.progress !== 0 || v.activeMs !== 0 || v.validTrackingMs !== 0) return null;
    metrics = { kind: 'skipped', progress: 0 };
  } else if (v.exerciseId === 'hold') {
    if (m.kind !== 'hold' || !number(m.bestHoldMs) || m.targetMs !== s.holdTargetMs || m.bestHoldMs > m.targetMs) return null;
    metrics = { kind: 'hold', bestHoldMs: m.bestHoldMs, targetMs: m.targetMs, progress: m.progress };
  } else {
    if (m.kind !== 'closure' || !number(m.startDistance) || !number(m.successDistance) || !number(m.bestDistance) ||
        m.startDistance <= m.successDistance || m.bestDistance > m.startDistance) return null;
    metrics = { kind: 'closure', startDistance: m.startDistance, successDistance: m.successDistance, bestDistance: m.bestDistance, progress: m.progress };
  }
  return { ...(linked ? { goalId: v.goalId, exerciseRunId: v.exerciseRunId, attemptOrder: v.attemptOrder } : {}), attemptId: v.attemptId, exerciseId: v.exerciseId, protocolVersion: v.protocolVersion,
    recognizerVersion: v.recognizerVersion, hand: v.hand, rulesVersion: v.rulesVersion,
    settings: { target: s.target, holdTargetMs: s.holdTargetMs, targetRadiusRatio: s.targetRadiusRatio, maxActiveMs: s.maxActiveMs,
      ...(ring ? { ring } : {}),
      ...(pair && s.movementPair ? { movementPair: [...s.movementPair] as unknown as FingerPair, movementStartDistance: s.movementStartDistance } : {}),
      ...(pair && s.pair ? { pair: [...s.pair] as unknown as FingerPair, pairRule: s.pairRule } : {}),
      ...(pair ? { pairTip: s.pairTip, sequenceIndex: s.sequenceIndex, partialRatio: s.partialRatio } : {}) },
    startedAt: v.startedAt, lastObservedAt: v.lastObservedAt, endedAt: v.endedAt, outcome: v.outcome, endReason: v.endReason,
    activeMs: v.activeMs, validTrackingMs: v.validTrackingMs,
    interruptions: { count: v.interruptions.count, durationMs: v.interruptions.durationMs }, metrics };
}

/** null denotes legacy unknown attempts; undefined denotes corrupt data. */
export function parseAttemptLog(v: unknown): AttemptLog | null | undefined {
  if (v === null) return null;
  if (!object(v) || typeof v.historyComplete !== 'boolean' || !Array.isArray(v.records)) return undefined;
  const records: Attempt[] = [], seen = new Set<string>();
  for (const entry of v.records) {
    const a = parseAttempt(entry, false);
    if (!a || seen.has(a.attemptId)) return undefined;
    records.push(a); seen.add(a.attemptId);
  }
  const active = v.active === null ? null : parseAttempt(v.active, true);
  if ((v.active !== null && !active) || (active && seen.has(active.attemptId))) return undefined;
  let runs: AttemptLog['runs'];
  if (v.runs !== undefined) {
    if (!Array.isArray(v.runs) || !v.runs.length || v.runs.length > 3) return undefined;
    const allIds = new Set<string>(), exercises = new Set<string>();
    runs = [];
    for (const r of v.runs) {
      if (!object(r) || !text(r.exerciseRunId) || !['pinch','grip','hold','opposition','ring'].includes(r.exerciseId) ||
          exercises.has(r.exerciseId) || allIds.has(r.exerciseRunId) || !Array.isArray(r.goalIds) || !r.goalIds.length || r.goalIds.length > 100 ||
          !r.goalIds.every(text)) return undefined;
      allIds.add(r.exerciseRunId); exercises.add(r.exerciseId);
      for (const id of r.goalIds) { if (allIds.has(id)) return undefined; allIds.add(id); }
      runs.push({ exerciseRunId: r.exerciseRunId, exerciseId: r.exerciseId, goalIds: [...r.goalIds] });
    }
    const orders = new Map<string, number>(), closed = new Set<string>();
    for (const a of [...records, ...(active ? [active] : [])]) {
      const run = runs.find(r => r.exerciseRunId === a.exerciseRunId);
      if (!run || run.exerciseId !== a.exerciseId || !a.goalId || !run.goalIds.includes(a.goalId) || closed.has(a.goalId) ||
          a.attemptOrder !== (orders.get(a.goalId) ?? 0) + 1) return undefined;
      orders.set(a.goalId, a.attemptOrder);
      if (a.outcome === 'completed' || a.endReason === 'skip') closed.add(a.goalId);
    }
  } else if ([...records, ...(active ? [active] : [])].some(a => a.goalId)) return undefined;
  return { ...(runs ? { runs } : {}), historyComplete: v.historyComplete, records, active };
}

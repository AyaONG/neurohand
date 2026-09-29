import type { Attempt, AttemptLog, AttemptMetrics } from './attempts';

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const count = (v: unknown): v is number => number(v) && Number.isSafeInteger(v);
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;

/** Strict projection: neither arbitrary metrics nor frame/landmark fields reach storage. */
function parseAttempt(v: unknown, active: boolean): Attempt | null {
  if (!object(v) || !text(v.attemptId) || !['pinch', 'grip', 'hold'].includes(v.exerciseId) ||
      !text(v.protocolVersion) || !text(v.recognizerVersion) || !text(v.rulesVersion) ||
      !['left', 'right', 'unspecified'].includes(v.hand) || !date(v.startedAt) || !date(v.lastObservedAt) ||
      Date.parse(v.lastObservedAt) < Date.parse(v.startedAt) || !number(v.activeMs) || !number(v.validTrackingMs) ||
      v.activeMs > v.validTrackingMs || !object(v.interruptions) || !count(v.interruptions.count) ||
      !number(v.interruptions.durationMs) || !object(v.settings) || !object(v.metrics)) return null;
  if (active ? v.outcome !== null || v.endedAt !== null || v.endReason !== null
    : !['completed', 'partial', 'incomplete', 'unscorable', 'cancelled'].includes(v.outcome) ||
      !['confirmed', 'returned', 'manual', 'pause', 'results', 'visibility', 'tracking', 'camera', 'reload', 'resize', 'timeout'].includes(v.endReason) ||
      !date(v.endedAt) || Date.parse(v.endedAt) < Date.parse(v.lastObservedAt)) return null;
  if ((v.outcome === 'completed') !== (v.endReason === 'confirmed')) return null;
  const s = v.settings, m = v.metrics;
  if (!count(s.target) || s.target === 0 || !number(s.holdTargetMs) || s.holdTargetMs === 0 ||
      !number(s.targetRadiusRatio) || s.targetRadiusRatio === 0 || s.targetRadiusRatio > 1 ||
      !number(s.maxActiveMs) || s.maxActiveMs === 0 || !number(m.progress) || m.progress > 1) return null;
  let metrics: AttemptMetrics;
  if (v.exerciseId === 'hold') {
    if (m.kind !== 'hold' || !number(m.bestHoldMs) || m.targetMs !== s.holdTargetMs || m.bestHoldMs > m.targetMs) return null;
    metrics = { kind: 'hold', bestHoldMs: m.bestHoldMs, targetMs: m.targetMs, progress: m.progress };
  } else {
    if (m.kind !== 'closure' || !number(m.startDistance) || !number(m.successDistance) || !number(m.bestDistance) ||
        m.startDistance <= m.successDistance || m.bestDistance > m.startDistance) return null;
    metrics = { kind: 'closure', startDistance: m.startDistance, successDistance: m.successDistance, bestDistance: m.bestDistance, progress: m.progress };
  }
  return { attemptId: v.attemptId, exerciseId: v.exerciseId, protocolVersion: v.protocolVersion,
    recognizerVersion: v.recognizerVersion, hand: v.hand, rulesVersion: v.rulesVersion,
    settings: { target: s.target, holdTargetMs: s.holdTargetMs, targetRadiusRatio: s.targetRadiusRatio, maxActiveMs: s.maxActiveMs },
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
  return { historyComplete: v.historyComplete, records, active };
}

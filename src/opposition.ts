import type { HandGeometry } from './geometry';
import type { Reading } from './types';
import type { Session } from './session';
import type { Attempt } from './attempts';

export const FINGER_TIPS = [8, 12, 16, 20] as const;
export type FingerTip = typeof FINGER_TIPS[number];
export const FINGER_NAMES: Record<FingerTip, string> = { 8: 'указательный', 12: 'средний', 16: 'безымянный', 20: 'мизинец' };
export const PAIR_RULES = Object.freeze({ version: 'opposition-v1', recognizerVersion: 'opposition-norm-v2',
  repeats: 2, readyMs: 250, intentMs: 150, confirmMs: 180, filterMs: 120,
  intentRatio: 0.1, partialRatio: 0.2, minRange: 0.2, maxActiveMs: 10000, maxGapMs: 250, lostPauseMs: 2000 });
// Valid observations must resume continuously before measuring again.
export const PAIR_AMBIGUITY = Object.freeze({ timeoutMs: 600, recoveryMs: 250 });
// Separate from PINCH_CLOSE/PINCH_OPEN. Initial values require real-camera acceptance for each pair.
export const PAIR_THRESHOLDS: Readonly<Record<FingerTip, { close: number; open: number }>> = Object.freeze({
  8: Object.freeze({ close: 0.26, open: 0.55 }), 12: Object.freeze({ close: 0.26, open: 0.55 }),
  16: Object.freeze({ close: 0.26, open: 0.55 }), 20: Object.freeze({ close: 0.26, open: 0.55 }),
});
export const EXTRA_PAIR_KEYS = ['8-12', '8-16', '8-20', '12-16', '12-20', '16-20'] as const;
export type PairKey = FingerTip | typeof EXTRA_PAIR_KEYS[number];
export type Tip = 4 | FingerTip;
export type FingerPair = readonly [Tip, Tip];
export const PAIR_CATALOG: readonly { id: PairKey; tips: FingerPair; experimental: boolean }[] = [
  { id: 8, tips: [4,8], experimental: false }, { id: 12, tips: [4,12], experimental: false },
  { id: 16, tips: [4,16], experimental: false }, { id: 20, tips: [4,20], experimental: false },
  { id: '8-12', tips: [8,12], experimental: true }, { id: '8-16', tips: [8,16], experimental: true },
  { id: '8-20', tips: [8,20], experimental: true }, { id: '12-16', tips: [12,16], experimental: true },
  { id: '12-20', tips: [12,20], experimental: true }, { id: '16-20', tips: [16,20], experimental: true },
];
export const ALL_PAIR_KEYS: readonly PairKey[] = PAIR_CATALOG.map(p => p.id);
export function pairOf(key: PairKey): FingerPair {
  const pair = PAIR_CATALOG.find(p => p.id === key);
  if (!pair) throw new Error('Unknown pair');
  return pair.tips;
}
export const pairLabel = (key: PairKey) => pairOf(key).map(t => t === 4 ? 'большой' : FINGER_NAMES[t]).join(' + ');
export const experimentalPair = (key: PairKey) => typeof key === 'string';
export const isPairKey = (v: unknown): v is PairKey => ALL_PAIR_KEYS.includes(v as PairKey);
export const isFingerTip = (value: unknown): value is FingerTip => FINGER_TIPS.includes(value as FingerTip);
// Experimental screen-proximity thresholds, independently versioned; not a contact sensor.
export const EXPERIMENTAL_PAIR_RULES = Object.freeze({ version: 'free-pairs-v1', close: 0.12, open: 0.25,
  minRange: 0.14, confirmMs: 300, intentRatio: 0.18, intentMs: 180, overlap: 0.025, maxDepthDifference: 0.18 });
export function pairRules(key: PairKey) {
  return { ...PAIR_RULES, ...(experimentalPair(key) ? EXPERIMENTAL_PAIR_RULES : PAIR_THRESHOLDS[key as FingerTip]) };
}
export type OppositionPlan = { allowed: PairKey[]; sequence: PairKey[]; cursor: number; awaitingRelease: boolean; rulesVersion: string };
export function createOppositionPlan(selected: PairKey[], random = Math.random): OppositionPlan {
  const allowed = ALL_PAIR_KEYS.filter(tip => selected.includes(tip));
  if (!allowed.length || selected.some(tip => !isPairKey(tip))) throw new Error('Выбери хотя бы одну пару');
  const sequence: PairKey[] = [];
  for (let round = 0; round < PAIR_RULES.repeats; round++) {
    const block = [...allowed];
    for (let i = block.length - 1; i > 0; i--) {
      const r = random();
      const j = Math.min(i, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * (i + 1))));
      [block[i], block[j]] = [block[j], block[i]];
    }
    sequence.push(...block);
  }
  return { allowed, sequence, cursor: 0, awaitingRelease: false, rulesVersion: allowed.some(experimentalPair) ? 'mixed-pairs-v2' : PAIR_RULES.version };
}
export function parseOppositionPlan(v: any): OppositionPlan | null {
  if (!v || !Array.isArray(v.allowed) || !v.allowed.length || !v.allowed.every(isPairKey) ||
      new Set(v.allowed).size !== v.allowed.length || !Array.isArray(v.sequence) ||
      v.sequence.length !== v.allowed.length * PAIR_RULES.repeats ||
      !v.sequence.every((t: unknown) => isPairKey(t) && v.allowed.includes(t)) ||
      !v.allowed.every((t: PairKey) => v.sequence.filter((tip: PairKey) => tip === t).length === PAIR_RULES.repeats) ||
      !Number.isSafeInteger(v.cursor) || v.cursor < 0 || v.cursor >= v.sequence.length ||
      typeof v.awaitingRelease !== 'boolean' ||
      v.rulesVersion !== (v.allowed.some(experimentalPair) ? 'mixed-pairs-v2' : PAIR_RULES.version)) return null;
  return { allowed: [...v.allowed], sequence: [...v.sequence], cursor: v.cursor, awaitingRelease: v.awaitingRelease, rulesVersion: v.rulesVersion };
}
export const currentPair = (s: Session): PairKey => s.opposition!.sequence[s.opposition!.cursor];
export const pairTask = (key: PairKey) => experimentalPair(key)
  ? `Сблизь кончики: ${pairLabel(key)}. Оставь маленький видимый зазор между кончиками, не накладывай их друг на друга. Экспериментальный режим; касание не измеряется`
  : key === 20 ? 'Соедини большой палец и мизинец' : `Соедини большой и ${FINGER_NAMES[key as FingerTip]} пальцы`;
export const pairDistances = (g: HandGeometry): Record<string, number> => Object.fromEntries(ALL_PAIR_KEYS.map(key => [key, g.nd(...pairOf(key))]));

/** Target-relative proximity only. No requirement to straighten unrelated fingers. */
export function readOpposition(g: HandGeometry, key: PairKey, baseline?: Record<string, number>): Reading {
  const rule = pairRules(key), [a, b] = pairOf(key), distance = g.nd(a, b);
  const experimental = experimentalPair(key);
  if (experimental && distance < rule.close) {
    if (distance < EXPERIMENTAL_PAIR_RULES.overlap) return { open: false, closed: false, error: {
      code: 'AMBIGUOUS_PAIR', ambiguityReason: 'overlap', joints: [a,b],
      message: 'Кончики накладываются друг на друга. Немного разведи их: оставь маленький видимый зазор' } };
    if (g.depthDifference(a,b) > EXPERIMENTAL_PAIR_RULES.maxDepthDifference) return { open: false, closed: false, error: {
      code: 'AMBIGUOUS_PAIR', ambiguityReason: 'depth', joints: [a,b],
      message: 'Один кончик выглядит ближе к камере. Поверни кисть, чтобы оба кончика были рядом на одной глубине' } };
    const third = ([4, ...FINGER_TIPS] as Tip[]).filter(t => t !== a && t !== b && Math.min(g.nd(a,t), g.nd(b,t)) < rule.close);
    if (third.length) return { open: false, closed: false, error: {
      code: 'AMBIGUOUS_PAIR', ambiguityReason: 'third_finger', joints: [a,b,...third],
      message: 'Рядом с выбранной парой ещё один кончик. Отведи его немного в сторону, чтобы выбранные два были различимы' } };
  }
  const wrong = ALL_PAIR_KEYS.filter(other => other !== key && g.nd(...pairOf(other)) < pairRules(other).close &&
    (baseline ? baseline[String(other)] - g.nd(...pairOf(other)) >= Math.max(0.1, pairRules(other).minRange)
      : !experimental && typeof other === 'number'));
  if (wrong.length && (!experimental || distance >= rule.close)) return { open: false, closed: false, error: {
    code: distance < rule.close ? 'AMBIGUOUS_PAIR' : 'WRONG_FINGER',
    ...(distance < rule.close ? { ambiguityReason: 'multiple_pairs' as const } : {}), joints: [...new Set(wrong.flatMap(k => [...pairOf(k)]))],
    message: distance < rule.close ? 'Одновременно сближены несколько пар. Разведи их и повтори движение только выбранной парой' : `Сомкнута другая пара. Разведи пальцы. ${pairTask(key)}`,
  } };
  return { open: distance > rule.open, closed: distance < rule.close, error: null };
}
export const consumesPair = (a: Attempt): boolean => a.exerciseId === 'opposition' &&
  ((a.goalId ? a.outcome === 'completed' : ['completed', 'partial', 'incomplete'].includes(a.outcome ?? '')) || a.endReason === 'skip');
export function pairCounts(s: Session) {
  const records = s.attempts?.records.filter(a => a.exerciseId === 'opposition') ?? [];
  return { completed: records.filter(a => a.outcome === 'completed').length,
    partial: records.filter(a => a.outcome === 'partial').length,
    incomplete: records.filter(a => a.outcome === 'incomplete').length,
    unscorable: records.filter(a => a.outcome === 'unscorable').length,
    skipped: records.filter(a => a.endReason === 'skip').length,
    consumed: records.filter(consumesPair).length };
}

/** Reconcile terminal events without advancing the target before release. Idempotent. */
export function settleOpposition(s: Session): Session {
  if (s.mode !== 'opposition') return s;
  const plan = s.opposition!, log = s.attempts!;
  const terminal = log.records.find(a => a.settings.sequenceIndex === plan.cursor && consumesPair(a));
  const awaitingRelease = plan.awaitingRelease || !!terminal;
  const done = awaitingRelease && plan.cursor === plan.sequence.length - 1;
  const records = [...log.records, ...(log.active ? [log.active] : [])];
  return { ...s, opposition: { ...plan, awaitingRelease },
    status: s.status === 'in_progress' && done ? 'completed' : s.status,
    endedAt: s.status === 'in_progress' && done ? terminal!.endedAt : s.endedAt,
    paused: done || s.paused,
    exercises: { ...s.exercises, opposition: { ...s.exercises.opposition!,
      started: records.length > 0, reps: pairCounts(s).completed,
      activeMs: records.reduce((n, a) => n + a.activeMs, 0) } } };
}

import type { HandGeometry } from './geometry';
import type { Reading } from './types';
import type { Session } from './session';
import type { Attempt } from './attempts';

export const FINGER_TIPS = [8, 12, 16, 20] as const;
export type FingerTip = typeof FINGER_TIPS[number];
export const FINGER_NAMES: Record<FingerTip, string> = { 8: 'указательный', 12: 'средний', 16: 'безымянный', 20: 'мизинец' };
export const PAIR_RULES = Object.freeze({ version: 'opposition-v1', recognizerVersion: 'opposition-norm-v1',
  repeats: 2, readyMs: 250, intentMs: 150, confirmMs: 180, filterMs: 120,
  intentRatio: 0.1, partialRatio: 0.2, minRange: 0.2, maxActiveMs: 10000, maxGapMs: 250, lostPauseMs: 2000 });
// Separate from PINCH_CLOSE/PINCH_OPEN. Initial values require real-camera acceptance for each pair.
export const PAIR_THRESHOLDS: Readonly<Record<FingerTip, { close: number; open: number }>> = Object.freeze({
  8: Object.freeze({ close: 0.26, open: 0.55 }), 12: Object.freeze({ close: 0.26, open: 0.55 }),
  16: Object.freeze({ close: 0.26, open: 0.55 }), 20: Object.freeze({ close: 0.26, open: 0.55 }),
});
export type OppositionPlan = { allowed: FingerTip[]; sequence: FingerTip[]; cursor: number; awaitingRelease: boolean; rulesVersion: string };
export const isFingerTip = (value: unknown): value is FingerTip => FINGER_TIPS.includes(value as FingerTip);
export function createOppositionPlan(selected: FingerTip[], random = Math.random): OppositionPlan {
  const allowed = FINGER_TIPS.filter(tip => selected.includes(tip));
  if (!allowed.length || selected.some(tip => !isFingerTip(tip))) throw new Error('Выбери хотя бы одну пару');
  const sequence: FingerTip[] = [];
  // A shuffled block contains each allowed pair once; exact balance across two blocks.
  for (let round = 0; round < PAIR_RULES.repeats; round++) {
    const block = [...allowed];
    for (let i = block.length - 1; i > 0; i--) {
      const r = random();
      const j = Math.min(i, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * (i + 1))));
      [block[i], block[j]] = [block[j], block[i]];
    }
    sequence.push(...block);
  }
  return { allowed, sequence, cursor: 0, awaitingRelease: false, rulesVersion: PAIR_RULES.version };
}
export function parseOppositionPlan(v: any): OppositionPlan | null {
  if (!v || !Array.isArray(v.allowed) || !v.allowed.length || !v.allowed.every(isFingerTip) ||
      new Set(v.allowed).size !== v.allowed.length || !Array.isArray(v.sequence) ||
      v.sequence.length !== v.allowed.length * PAIR_RULES.repeats ||
      !v.sequence.every((t: unknown) => isFingerTip(t) && v.allowed.includes(t)) ||
      !v.allowed.every((t: FingerTip) => v.sequence.filter((tip: FingerTip) => tip === t).length === PAIR_RULES.repeats) ||
      !Number.isSafeInteger(v.cursor) || v.cursor < 0 || v.cursor >= v.sequence.length ||
      typeof v.awaitingRelease !== 'boolean' || v.rulesVersion !== PAIR_RULES.version) return null;
  return { allowed: [...v.allowed], sequence: [...v.sequence], cursor: v.cursor, awaitingRelease: v.awaitingRelease, rulesVersion: v.rulesVersion };
}
export const currentPair = (s: Session): FingerTip => s.opposition!.sequence[s.opposition!.cursor];
export const pairTask = (tip: FingerTip) => tip === 20 ? 'Соедини большой палец и мизинец' : `Соедини большой и ${FINGER_NAMES[tip]} пальцы`;

/** A target-specific validator. Never call the base index-pinch validator for this mode. */
export function readOpposition(g: HandGeometry, tip: FingerTip): Reading {
  const { close, open } = PAIR_THRESHOLDS[tip];
  const distance = g.nd(4, tip);
  const wrong = FINGER_TIPS.filter(other => other !== tip && g.nd(4, other) < PAIR_THRESHOLDS[other].close);
  if (wrong.length) return { open: false, closed: false, error: {
    code: distance < close ? 'AMBIGUOUS_PAIR' : 'WRONG_FINGER', joints: [4, ...wrong],
    message: distance < close ? 'Не удаётся различить пару. Разведи пальцы и повтори' : `Сомкнута другая пара. Разведи пальцы. ${pairTask(tip)}`,
  } };
  return { open: distance > open, closed: distance < close, error: null };
}
export const consumesPair = (a: Attempt): boolean => a.exerciseId === 'opposition' &&
  (['completed', 'partial', 'incomplete'].includes(a.outcome ?? '') || a.endReason === 'skip');
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

import { parseOppositionPlan, consumesPair, PAIR_RULES, PAIR_THRESHOLDS } from './opposition';
import { closeActive } from './attempts';
import { parseAttemptLog } from './attempt-storage';
import type { Session, ExerciseResult } from './session';
import type { ExerciseId } from './types';

export const STORAGE_KEY = 'neurohand:progress:v3';
export const V2_STORAGE_KEY = 'neurohand:progress:v2';
export const LEGACY_KEY = 'neurohand-session';
const ids = ['pinch', 'grip', 'hold'] as const;
export type LegacyRecord = { kind: 'legacy'; counters: Partial<Record<ExerciseId, number>> };
export type Progress = { schemaVersion: 3; current: Session | null; history: Session[] };
export const MEMORY_NOTICE = 'В этом браузере история не сохраняется. Итоги доступны до закрытия страницы';
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const count = (v: unknown): v is number => number(v) && Number.isSafeInteger(v);
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));

/** Validate and project onto an explicit allowlist: never persist frame data or extra fields. */
export function parseSession(v: unknown): Session | null {
  if (!object(v) || ![2, 3].includes(v.schemaVersion) || typeof v.id !== 'string' || !v.id || !date(v.startedAt) ||
      !['in_progress', 'completed', 'stopped'].includes(v.status) || !((v.mode === 'guided' && v.protocolId === 'guided-v1') || (v.schemaVersion === 3 && v.mode === 'opposition' && v.protocolId === 'opposition-v1')) ||
      typeof v.recognitionVersion !== 'string' || !v.recognitionVersion || !['left', 'right', 'unspecified'].includes(v.hand) ||
      !(v.mode === 'opposition' ? v.currentExercise === 'opposition' : ids.includes(v.currentExercise)) || typeof v.paused !== 'boolean' || !object(v.settings) || !object(v.exercises)) return null;
  if (v.status === 'in_progress' ? v.endedAt !== null : !date(v.endedAt) || Date.parse(v.endedAt) < Date.parse(v.startedAt)) return null;
  const attempts = v.schemaVersion === 2 ? null : parseAttemptLog(v.attempts);
  if (attempts === undefined || (attempts?.active && (v.status !== 'in_progress' || attempts.active.exerciseId !== v.currentExercise))) return null;
  const s = v.settings;
  if (![s.pinchTarget, s.gripTarget, s.holdTargetCount].every(n => count(n) && n > 0) ||
      !number(s.holdTargetMs) || s.holdTargetMs <= 0 || !number(s.targetRadiusRatio) || s.targetRadiusRatio <= 0 || s.targetRadiusRatio > 1) return null;
  const exercises = {} as Record<ExerciseId, ExerciseResult>;
  for (const [i, id] of ids.entries()) {
    const r = v.exercises[id];
    if (!object(r) || !count(r.reps) || r.target !== [s.pinchTarget, s.gripTarget, s.holdTargetCount][i] ||
        r.reps > r.target || typeof r.started !== 'boolean' || !number(r.activeMs) || !object(r.promptEpisodes) ||
        !Object.values(r.promptEpisodes).every(count) || (r.bestHoldMs !== null && (!number(r.bestHoldMs) || r.bestHoldMs > s.holdTargetMs)) ||
        (!r.started && (r.reps > 0 || r.activeMs > 0 || Object.values(r.promptEpisodes).some(n => n > 0))) ||
        (v.mode === 'guided' && v.status === 'completed' && r.reps !== r.target)) return null;
    exercises[id] = { reps: r.reps, target: r.target, started: r.started, activeMs: r.activeMs,
      promptEpisodes: Object.fromEntries(Object.entries(r.promptEpisodes)), bestHoldMs: r.bestHoldMs };
  }
  const opposition = v.mode === 'opposition' ? parseOppositionPlan(v.opposition) : null;
  if (v.mode === 'opposition') {
    if (!opposition || !attempts || !attempts.historyComplete || v.recognitionVersion !== PAIR_RULES.recognizerVersion) return null;
    const records = [...attempts.records, ...(attempts.active ? [attempts.active] : [])];
    const used = new Set<number>();
    for (const a of records) {
      const i = a.settings.sequenceIndex;
      if (a.exerciseId !== 'opposition' || i === undefined || i > opposition.cursor ||
          a.settings.pairTip !== opposition.sequence[i] || a.settings.target !== opposition.sequence.length ||
          (a.metrics.kind === 'closure' && a.metrics.successDistance !== PAIR_THRESHOLDS[a.settings.pairTip!].close) ||
          a.hand !== v.hand || a.protocolVersion !== v.protocolId || a.recognizerVersion !== v.recognitionVersion) return null;
      if (consumesPair(a)) { if (used.has(i)) return null; used.add(i); }
    }
    if (Array.from({ length: opposition.cursor }, (_, i) => i).some(i => !used.has(i)) ||
        used.has(opposition.cursor) !== opposition.awaitingRelease ||
        (attempts.active && (opposition.awaitingRelease || attempts.active.settings.sequenceIndex !== opposition.cursor))) return null;
    const done = opposition.awaitingRelease && opposition.cursor === opposition.sequence.length - 1;
    if ((v.status === 'completed') !== done) return null;
    const r = v.exercises.opposition;
    if (!object(r) || r.target !== opposition.sequence.length || !count(r.reps) ||
        r.reps !== attempts.records.filter(a => a.outcome === 'completed').length ||
        r.started !== (records.length > 0) || !number(r.activeMs) || r.activeMs !== records.reduce((n, a) => n + a.activeMs, 0) ||
        r.bestHoldMs !== null || !object(r.promptEpisodes) || !Object.values(r.promptEpisodes).every(count)) return null;
    exercises.opposition = { reps: r.reps, target: r.target, started: r.started, activeMs: r.activeMs,
      promptEpisodes: { ...r.promptEpisodes }, bestHoldMs: null };
  } else if (attempts && [...attempts.records, ...(attempts.active ? [attempts.active] : [])].some(a => a.exerciseId === 'opposition')) return null;
  return { schemaVersion: 3, attempts, ...(opposition ? { opposition } : {}), id: v.id, startedAt: v.startedAt, endedAt: v.endedAt, status: v.status,
    mode: v.mode, protocolId: v.protocolId, recognitionVersion: v.recognitionVersion, hand: v.hand,
    settings: { pinchTarget: s.pinchTarget, gripTarget: s.gripTarget, holdTargetCount: s.holdTargetCount,
      holdTargetMs: s.holdTargetMs, targetRadiusRatio: s.targetRadiusRatio },
    currentExercise: v.currentExercise, paused: v.paused, exercises };
}

export function parseLegacy(v: unknown): LegacyRecord | null {
  if (!object(v) || (v.schemaVersion !== undefined && v.schemaVersion !== 1)) return null;
  // Old counter-only records have no reliable dates, hand or recognition version.
  const source = object(v.exercises) ? v.exercises : v;
  const counters: LegacyRecord['counters'] = {};
  for (const id of ids) {
    const entry = source[id];
    if (object(entry) && count(entry.reps)) counters[id] = entry.reps;
  }
  return Object.keys(counters).length ? { kind: 'legacy', counters } : null;
}

export function comparable(a: Session, b: Session): boolean {
  return a.status === 'completed' && b.status === 'completed' && a.hand !== 'unspecified' && a.hand === b.hand &&
    a.mode === b.mode && (a.mode !== 'opposition' || (a.opposition?.rulesVersion === b.opposition?.rulesVersion && JSON.stringify(a.opposition?.sequence) === JSON.stringify(b.opposition?.sequence))) && a.protocolId === b.protocolId && a.recognitionVersion === b.recognitionVersion &&
    (Object.keys(a.settings) as (keyof Session['settings'])[]).every(key => a.settings[key] === b.settings[key]);
}

export class ProgressStore {
  data: Progress = { schemaVersion: 3, current: null, history: [] };
  legacy: LegacyRecord | null = null;
  notice = '';
  private storage: Pick<Storage, 'getItem' | 'setItem'> | null = null;
  private writable = true;
  private lastEvent = '';
  private lastSaveMs = -Infinity;
  private lastWritten = '';
  constructor(getStorage: () => Pick<Storage, 'getItem' | 'setItem'> = () => window.localStorage) {
    try {
      this.storage = getStorage();
      const currentRaw = this.storage.getItem(STORAGE_KEY);
      const migrating = currentRaw === null;
      const raw = currentRaw ?? this.storage.getItem(V2_STORAGE_KEY);
      if (raw !== null) {
        const v: unknown = JSON.parse(raw);
        if (!object(v) || v.schemaVersion !== (migrating ? 2 : 3) || !Array.isArray(v.history)) throw new Error('schema');
        let invalid = false;
        const seen = new Set<string>();
        for (const entry of v.history) {
          if (!object(entry) || entry.schemaVersion !== v.schemaVersion) { invalid = true; continue; }
          const session = parseSession(entry);
          if (!session || session.status === 'in_progress') { invalid = true; continue; }
          if (!seen.has(session.id)) { this.data.history.push(session); seen.add(session.id); }
        }
        this.data.history.sort((a, b) => Date.parse(b.endedAt!) - Date.parse(a.endedAt!));
        this.data.history = this.data.history.slice(0, 30);
        if (v.current !== null) {
          const current = parseSession(v.current);
          if (!current || v.current.schemaVersion !== v.schemaVersion || current.status !== 'in_progress') invalid = true;
          else if (!seen.has(current.id)) this.data.current = { ...current, paused: true, attempts: closeActive(current.attempts, 'reload') };
        }
        if (invalid) throw new Error('record');
        // Migrate only after validating the whole source. Keep v2 byte-for-byte intact.
        // Also persist reload finalization before a second reload can replay it.
        if (migrating || this.data.current) {
          const serialized = JSON.stringify(this.data);
          this.storage.setItem(STORAGE_KEY, serialized);
          this.lastWritten = serialized;
        }
      }
    } catch {
      this.writable = false;
      this.notice = `${MEMORY_NOTICE}. Сохранённые данные недоступны или повреждены; исходный ключ не изменён.`;
    }
    try {
      const raw = this.storage?.getItem(LEGACY_KEY);
      if (raw) {
        this.legacy = parseLegacy(JSON.parse(raw));
        if (!this.legacy) this.notice += ' Старая запись не распознана; исходный ключ сохранён.';
      }
    } catch { this.notice += ' Старая запись недоступна или повреждена; исходный ключ сохранён.'; }
  }

  /** Called at frame boundaries; only discrete events or a 2s aggregate checkpoint write. */
  save(session: Session, timestampMs: number, force = false): void {
    const clean = parseSession(session);
    if (!clean) return;
    const event = JSON.stringify([clean.id, clean.status, clean.paused, clean.currentExercise, clean.hand, clean.opposition?.cursor, clean.opposition?.awaitingRelease,
      clean.attempts?.active?.attemptId, clean.attempts?.records.length, clean.attempts?.active?.interruptions.count,
      ids.map(id => [clean.exercises[id].reps, clean.exercises[id].started, clean.exercises[id].promptEpisodes])]);
    if (!force && event === this.lastEvent && timestampMs - this.lastSaveMs < 2000) return;
    if (this.data.history.some(s => s.id === clean.id)) return; // finalized snapshots are immutable
    this.lastEvent = event;
    this.lastSaveMs = timestampMs;
    if (clean.status === 'in_progress') this.data.current = clean;
    else {
      if (this.data.current?.id === clean.id) this.data.current = null;
      this.data.history = [clean, ...this.data.history].sort((a, b) => Date.parse(b.endedAt!) - Date.parse(a.endedAt!)).slice(0, 30);
    }
    if (!this.writable) return;
    try {
      const serialized = JSON.stringify(this.data);
      if (serialized !== this.lastWritten) {
        this.storage!.setItem(STORAGE_KEY, serialized);
        this.lastWritten = serialized;
      }
    }
    catch { this.writable = false; this.notice = MEMORY_NOTICE; }
  }
}

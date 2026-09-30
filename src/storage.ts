import { sameSession } from './session-equality';
import { comparableResults } from './progress';
import { parseRingSettings, settleRing, finishesRing } from './ring';
import { parseOppositionPlan, consumesPair, PAIR_RULES, pairRules } from './opposition';
import { closeActive } from './attempts';
import { parseAttemptLog } from './attempt-storage';
import type { Session, ExerciseResult } from './session';
import type { ExerciseId } from './types';

export const STORAGE_KEY = 'neurohand:progress:v3';
export const V2_STORAGE_KEY = 'neurohand:progress:v2';
export const LEGACY_KEY = 'neurohand-session';
const ids = ['pinch', 'grip', 'hold'] as const;
export type LegacyRecord = { kind: 'legacy'; counters: Partial<Record<ExerciseId, number>> };
export type SyncState = { status: 'pending' | 'saved' | 'retry' | 'error'; failures: number; retryAt: number; message?: string; guestImported?: boolean };
export type Progress = { schemaVersion: 3; current: Session | null; history: Session[]; sync?: Record<string, SyncState> };
export const MEMORY_NOTICE = 'В этом браузере история не сохраняется. Итоги доступны до закрытия страницы';
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const count = (v: unknown): v is number => number(v) && Number.isSafeInteger(v);
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));

/** Validate and project onto an explicit allowlist: never persist frame data or extra fields. */
export function parseSession(v: unknown): Session | null {
  if (!object(v) || ![2, 3].includes(v.schemaVersion) || typeof v.id !== 'string' || !v.id || !date(v.startedAt) ||
      !['in_progress', 'completed', 'stopped'].includes(v.status) || !((v.mode === 'guided' && v.protocolId === 'guided-v1') || (v.schemaVersion === 3 && ((v.mode === 'opposition' && v.protocolId === 'opposition-v1') || (v.mode === 'ring' && v.protocolId === 'ring-v1')))) ||
      typeof v.recognitionVersion !== 'string' || !v.recognitionVersion || !['left', 'right', 'unspecified'].includes(v.hand) ||
      !(v.mode !== 'guided' ? v.currentExercise === v.mode : ids.includes(v.currentExercise)) || typeof v.paused !== 'boolean' || !object(v.settings) || !object(v.exercises)) return null;
  if (v.status === 'in_progress' ? v.endedAt !== null : !date(v.endedAt) || Date.parse(v.endedAt) < Date.parse(v.startedAt)) return null;
  const attempts = v.schemaVersion === 2 ? null : parseAttemptLog(v.attempts);
  if (attempts === undefined || (attempts?.active && (v.status !== 'in_progress' || attempts.active.exerciseId !== v.currentExercise))) return null;
  if (attempts?.runs) {
    const expected = v.mode === 'guided' ? ['pinch','grip','hold'] : [v.mode];
    if (attempts.runs.length !== expected.length || attempts.runs.some(r => !expected.includes(r.exerciseId) ||
        r.goalIds.length !== v.exercises[r.exerciseId]?.target)) return null;
  }
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
  const ring = v.mode === 'ring' ? parseRingSettings(v.ring) : null;
  if (v.mode === 'ring') {
    if (!ring || !attempts?.historyComplete || v.recognitionVersion !== 'ring-screen-v1') return null;
    const records = [...attempts.records, ...(attempts.active ? [attempts.active] : [])];
    if (records.some(a => a.exerciseId !== 'ring' || JSON.stringify(a.settings.ring) !== JSON.stringify(ring) || a.hand !== v.hand || a.protocolVersion !== v.protocolId || a.recognizerVersion !== v.recognitionVersion)) return null;
    const terminals = attempts.records.filter(finishesRing);
    if (terminals.length > 1 || (v.status === 'completed') !== (terminals.length === 1) ||
        (terminals.length && (attempts.records.at(-1) !== terminals[0] || v.endedAt !== terminals[0].endedAt))) return null;
    const projected = settleRing({ ...v, ring, attempts } as Session);
    if (projected.status !== v.status || JSON.stringify(projected.exercises.ring) !== JSON.stringify(v.exercises.ring) || records.filter(a => a.outcome === 'completed').length > 1) return null;
    exercises.ring = projected.exercises.ring!;
  } else if (v.mode === 'opposition') {
    if (!opposition || !attempts || !attempts.historyComplete || !(opposition.rulesVersion === 'mixed-pairs-v2' ? ['opposition-mixed-norm-v2', 'opposition-mixed-norm-v3'] : ['opposition-norm-v1', PAIR_RULES.recognizerVersion]).includes(v.recognitionVersion)) return null;
    const records = [...attempts.records, ...(attempts.active ? [attempts.active] : [])];
    const used = new Set<number>();
    for (const a of records) {
      const i = a.settings.sequenceIndex;
      if (attempts.runs && a.goalId !== attempts.runs[0].goalIds[i!]) return null;
      if (a.exerciseId !== 'opposition' || i === undefined || i > opposition.cursor ||
          a.settings.pairTip !== opposition.sequence[i] || a.settings.target !== opposition.sequence.length ||
          (a.metrics.kind === 'closure' && a.metrics.successDistance !== pairRules(a.settings.pairTip!).close) ||
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
  } else if (attempts && [...attempts.records, ...(attempts.active ? [attempts.active] : [])].some(a => a.exerciseId === 'opposition' || a.exerciseId === 'ring')) return null;
  return { schemaVersion: 3, attempts, ...(ring ? { ring } : {}), ...(opposition ? { opposition } : {}), id: v.id, startedAt: v.startedAt, endedAt: v.endedAt, status: v.status,
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

export const comparable = comparableResults;

export class ProgressStore {
  data: Progress = { schemaVersion: 3, current: null, history: [] };
  legacy: LegacyRecord | null = null;
  notice = '';
  account = false;
  get durable() { return this.writable; }
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
        // Display limits belong to the UI; every local record remains available for future sync.
        if (v.current !== null) {
          const current = parseSession(v.current);
          if (!current || v.current.schemaVersion !== v.schemaVersion || current.status !== 'in_progress') invalid = true;
          else if (!seen.has(current.id)) this.data.current = { ...current, paused: true, attempts: closeActive(current.attempts, 'reload') };
        }
        if (v.sync !== undefined) {
          if (!object(v.sync)) invalid = true;
          else {
            const sync: Record<string, SyncState> = Object.create(null);
            for (const [id, state] of Object.entries(v.sync)) {
              if (!seen.has(id) || !object(state) || !['pending', 'saved', 'retry', 'error'].includes(state.status) ||
                  !count(state.failures) || !number(state.retryAt) || (state.message !== undefined && (typeof state.message !== 'string' || state.message.length > 500)) ||
                  (state.guestImported !== undefined && typeof state.guestImported !== 'boolean')) { invalid = true; continue; }
              sync[id] = { status: state.status, failures: state.failures, retryAt: state.retryAt,
                ...(state.message ? { message: state.message } : {}), ...(state.guestImported ? { guestImported: true } : {}) };
            }
            this.data.sync = sync;
          }
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
      clean.attempts?.active?.metrics.kind === 'ring' ? clean.attempts.active.metrics.marks : null,
      clean.attempts?.active?.attemptId, clean.attempts?.records.length, clean.attempts?.active?.interruptions.count,
      ids.map(id => [clean.exercises[id].reps, clean.exercises[id].started, clean.exercises[id].promptEpisodes])]);
    if (!force && event === this.lastEvent && timestampMs - this.lastSaveMs < 2000) return;
    if (this.data.history.some(s => s.id === clean.id)) return; // finalized snapshots are immutable
    this.lastEvent = event;
    this.lastSaveMs = timestampMs;
    if (clean.status === 'in_progress') this.data.current = clean;
    else {
      if (this.data.current?.id === clean.id) this.data.current = null;
      this.data.history = [clean, ...this.data.history].sort((a, b) => Date.parse(b.endedAt!) - Date.parse(a.endedAt!));
    }
    this.write();
  }

  syncState(id: string): SyncState | undefined {
    return this.data.sync && Object.hasOwn(this.data.sync, id) ? this.data.sync[id] : undefined;
  }
  setSync(id: string, state: SyncState): void {
    if (!this.data.history.some(s => s.id === id)) return;
    this.data.sync = { ...this.data.sync, [id]: { ...state, ...(this.syncState(id)?.guestImported ? { guestImported: true } : {}) } };
    this.write();
  }
  storageLabel(id: string): string {
    const state = this.syncState(id);
    if (this.account && state?.status === 'saved') return 'Сохранено в аккаунте';
    if (!this.account || !this.data.history.some(s => s.id === id)) return this.writable ? 'В этом браузере' : 'Только в памяти · локальное сохранение недоступно';
    if (state?.status === 'error') return `${this.writable ? 'В этом браузере' : 'Только в памяти'} · ошибка синхронизации: ${state.message ?? 'требуется проверка'}`;
    return 'Ожидает синхронизации' + (this.writable ? '' : ' · копия только в памяти');
  }
  /** Immutable union; conflicts never replace a local final or active training. */
  mergeFinal(session: Session, acknowledged = false, guestImported = false): 'added' | 'same' | 'conflict' {
    const clean = parseSession(session);
    if (!clean || clean.status === 'in_progress' || this.data.current?.id === clean.id) return 'conflict';
    const previous = this.data.history.find(s => s.id === clean.id);
    if (previous && !sameSession(previous, clean)) return 'conflict';
    if (!previous) this.data.history = [...this.data.history, clean].sort((a,b) => Date.parse(b.endedAt!) - Date.parse(a.endedAt!));
    if (acknowledged || guestImported) this.data.sync = { ...this.data.sync, [clean.id]: {
      status: acknowledged || this.syncState(clean.id)?.status === 'saved' ? 'saved' : 'pending', failures: 0, retryAt: 0,
      ...(guestImported || this.syncState(clean.id)?.guestImported ? { guestImported: true } : {}),
    } };
    this.write(); return previous ? 'same' : 'added';
  }

  private write(): void {
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

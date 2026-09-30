import type { SupabaseClient } from '@supabase/supabase-js';
import { parseSession } from './storage';
import { sameSession } from './session-equality';
import { Profiles, type OwnerTicket } from './profiles';
import type { Session } from './session';
export const PAGE_SIZE = 30;
export type Cursor = { endedAt: string; id: string };
export type CloudRow = { user_id: string; id: string; schema_version: number; started_at: string; ended_at: string; status: string; payload: unknown };
export class SyncError extends Error {
  code: string; status: number;
  constructor(message: string, code = '', status = 0) { super(message); this.code = code; this.status = status; }
}
export interface Transport {
  insert(owner: string, session: Session, signal: AbortSignal): Promise<CloudRow>;
  get(owner: string, id: string, signal: AbortSignal): Promise<CloudRow | null>;
  page(owner: string, cursor: Cursor | null, signal: AbortSignal): Promise<CloudRow[]>;
}
async function request<T>(parent: AbortSignal, action: (signal: AbortSignal) => PromiseLike<T>): Promise<T> {
  const controller = new AbortController();
  let rejectTimeout!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const stop = () => { controller.abort(); rejectTimeout(new SyncError('Запрос прерван', '', 0)); };
  parent.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, 15000);
  if (parent.aborted) stop();
  try { return await Promise.race([action(controller.signal), deadline]); }
  finally { clearTimeout(timer); parent.removeEventListener('abort', stop); }
}
const columns = 'user_id,id,schema_version,started_at,ended_at,status,payload';
function failure(error: { code?: string }, status: number) { return new SyncError('Запрос не выполнен', error.code, status); }
export function supabaseTransport(client: SupabaseClient): Transport {
  return {
    async insert(owner, session, signal) {
      const { data, error, status } = await request(signal, requestSignal => client.from('training_sessions').insert({ user_id: owner, id: session.id,
        schema_version: 3, started_at: session.startedAt, ended_at: session.endedAt, status: session.status, payload: session })
        .select(columns).abortSignal(requestSignal).single());
      if (error) throw failure(error, status); return data as CloudRow;
    },
    async get(owner, id, signal) {
      const { data, error, status } = await request(signal, requestSignal => client.from('training_sessions').select(columns).eq('user_id', owner).eq('id', id).abortSignal(requestSignal).maybeSingle());
      if (error) throw failure(error, status); return data as CloudRow | null;
    },
    async page(owner, cursor, signal) {
      let query = client.from('training_sessions').select(columns).eq('user_id', owner)
        .order('ended_at', { ascending: false }).order('id', { ascending: true }).limit(PAGE_SIZE);
      // PostgREST quoted values; commas/quotes in legacy string IDs cannot change filter structure.
      if (cursor) query = query.or(`ended_at.lt.${JSON.stringify(cursor.endedAt)},and(ended_at.eq.${JSON.stringify(cursor.endedAt)},id.gt.${JSON.stringify(cursor.id)})`);
      const { data, error, status } = await request(signal, requestSignal => query.abortSignal(requestSignal));
      if (error) throw failure(error, status); return data as CloudRow[];
    },
  };
}
export function validateRow(row: CloudRow, owner: string): Session {
  const session = row && parseSession(row.payload);
  if (!session || session.status === 'in_progress' || row.user_id !== owner || row.id !== session.id || row.schema_version !== 3 ||
      row.status !== session.status || Date.parse(row.started_at) !== Date.parse(session.startedAt) || Date.parse(row.ended_at) !== Date.parse(session.endedAt!) ||
      !sameSession(session, row.payload)) throw new SyncError('Неверная облачная запись или владелец', 'INVALID', 400);
  return session;
}
const transient = (e: unknown) => !(e instanceof SyncError) || e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500;
export const retryDelay = (failures: number) => Math.min(60000, 2000 * 2 ** Math.min(Math.max(failures - 1, 0), 5));
const problem = (e: unknown) => e instanceof SyncError && e.code === 'CONFLICT' ? 'Одинаковый id, но разные итоги. Автоматическая замена запрещена.' :
  e instanceof SyncError && (e.status === 401 || e.status === 403 || e.code === '42501') ? 'Нет доступа. Проверь вход и политики RLS.' :
  transient(e) ? 'Сеть недоступна. Повторим с задержкой.' : 'Сервер отклонил данные. Проверь схему и настройки.';
export class SyncEngine {
  message = ''; loading = false; more = true;
  private profiles: Profiles; private transport: Transport | null; private changed: () => void; private now: () => number;
  private abort = new AbortController(); private epoch = 0;
  private uploadBusy = false; private timer: ReturnType<typeof setTimeout> | undefined;
  private pageTimer: ReturnType<typeof setTimeout> | undefined; private pageFailures = 0;
  private cursor: Cursor | null = null; private online = true;
  constructor(profiles: Profiles, transport: Transport | null, changed = () => {}, now = Date.now) {
    this.profiles = profiles; this.transport = transport; this.changed = changed; this.now = now;
  }
  reset() {
    this.abort.abort(); this.abort = new AbortController(); this.epoch++; clearTimeout(this.timer); clearTimeout(this.pageTimer);
    this.uploadBusy = this.loading = false; this.cursor = null; this.more = true; this.pageFailures = 0; this.message = ''; this.changed();
  }
  private valid(ticket: OwnerTicket, epoch: number) { return epoch === this.epoch && this.profiles.accepts(ticket); }
  get isOnline() { return this.online; }
  setOnline(online: boolean) { this.online = online; if (online) { void this.flush(); void this.loadMore(true); } }
  retry() {
    this.reset();
    for (const s of this.profiles.store.data.history) if (['error', 'retry'].includes(this.profiles.store.syncState(s.id)?.status ?? '')) {
      this.profiles.store.setSync(s.id, { status: 'pending', failures: 0, retryAt: 0 });
    }
    void this.flush(); void this.loadMore(true);
  }
  async flush(): Promise<void> {
    if (!this.transport || !this.online || this.uploadBusy || this.profiles.owner === 'guest') return;
    this.uploadBusy = true; clearTimeout(this.timer);
    const ticket = this.profiles.ticket(), epoch = this.epoch, store = this.profiles.store, signal = this.abort.signal;
    try {
      while (this.valid(ticket, epoch) && this.online) {
        const pending = this.profiles.pending(ticket);
        const item = pending.find(p => (store.syncState(p.id)?.retryAt ?? 0) <= this.now());
        if (!item) {
          if (pending.length) {
            const due = Math.min(...pending.map(p => store.syncState(p.id)?.retryAt ?? 0));
            this.timer = setTimeout(() => { void this.flush(); }, Math.max(1, due - this.now()));
          }
          break;
        }
        try {
          const clean = parseSession(item.payload);
          if (!clean || clean.status === 'in_progress' || item.id.length > 200 || new TextEncoder().encode(JSON.stringify(clean)).length > 524288) throw new SyncError('Invalid local result', 'INVALID', 400);
          let row: CloudRow | null;
          try { row = await this.transport.insert(ticket.owner.slice(5), clean, signal); }
          catch (e) {
            if (!this.valid(ticket, epoch)) return;
            if (!(e instanceof SyncError) || e.code !== '23505') throw e;
            row = await this.transport.get(ticket.owner.slice(5), item.id, signal);
          }
          if (!this.valid(ticket, epoch)) return;
          if (!row) throw new SyncError('Нет подтверждения сервера', '', 503);
          const remote = validateRow(row, ticket.owner.slice(5));
          if (!sameSession(remote, clean)) throw new SyncError('Conflict', 'CONFLICT', 409);
          store.setSync(item.id, { status: 'saved', failures: 0, retryAt: 0 });
        } catch (e) {
          if (!this.valid(ticket, epoch)) return;
          const failures = (store.syncState(item.id)?.failures ?? 0) + 1;
          store.setSync(item.id, { status: transient(e) ? 'retry' : 'error', failures,
            retryAt: transient(e) ? this.now() + retryDelay(failures) : 0, message: problem(e) });
        }
        this.changed();
      }
    } finally { if (this.valid(ticket, epoch)) { this.uploadBusy = false; this.changed(); } }
  }
  async loadMore(reset = false): Promise<void> {
    if (!this.transport || !this.online || this.loading || this.profiles.owner === 'guest' || (!reset && !this.more)) return;
    const ticket = this.profiles.ticket(), epoch = this.epoch, store = this.profiles.store, signal = this.abort.signal;
    const cursor = reset ? null : this.cursor;
    this.loading = true; clearTimeout(this.pageTimer); this.changed();
    try {
      const rows = await this.transport.page(ticket.owner.slice(5), cursor, signal);
      if (!this.valid(ticket, epoch)) return;
      if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw new SyncError('Invalid page', 'INVALID', 400);
      const parsed = rows.map(row => validateRow(row, ticket.owner.slice(5)));
      let conflicts = 0;
      for (const session of parsed) {
        if (store.mergeFinal(session, true) === 'conflict') {
          store.setSync(session.id, { status: 'error', failures: 0, retryAt: 0, message: problem(new SyncError('', 'CONFLICT', 409)) }); conflicts++;
        }
      }
      const last = rows.at(-1);
      const next = last ? { endedAt: last.ended_at, id: last.id } : cursor;
      if (last && cursor && sameSession(cursor, next)) throw new SyncError('Cursor did not advance', 'INVALID', 400);
      this.cursor = next; this.more = rows.length === PAGE_SIZE; this.pageFailures = 0;
      this.message = conflicts ? `Конфликтов: ${conflicts}. Локальные итоги сохранены.` : `Из аккаунта загружено: ${rows.length}. Локальные записи сохранены.`;
    } catch (e) {
      if (!this.valid(ticket, epoch)) return;
      this.message = problem(e);
      if (transient(e)) this.pageTimer = setTimeout(() => { void this.loadMore(reset); }, retryDelay(++this.pageFailures));
    } finally { if (this.valid(ticket, epoch)) { this.loading = false; this.changed(); } }
  }
}

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Profiles, userOwner, scopedStorage } from '../src/profiles';
import { createSession, finishSession, type Session } from '../src/session';
import { SyncEngine, SyncError, PAGE_SIZE, retryDelay, type Transport, type CloudRow } from '../src/sync';
import { STORAGE_KEY, ProgressStore } from '../src/storage';
import { exportAggregates, importAggregates, parseAggregates, MAX_TRANSFER_BYTES } from '../src/transfer';
import { sameSession } from '../src/session-equality';
const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
const final = (id: string, reps = 0) => {
  const s = createSession(id, '2026-09-30T00:00:00Z');
  if (reps) s.exercises.pinch = { ...s.exercises.pinch, reps, started: true };
  return finishSession(s, 'stopped', '2026-09-30T00:01:00Z');
};
const row = (owner: string, s: Session): CloudRow => ({ user_id: owner, id: s.id, schema_version: 3, started_at: s.startedAt, ended_at: s.endedAt!, status: s.status, payload: structuredClone(s) });
function memory() { const values = new Map<string, string>(); return { values, getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } }; }
function server() {
  const rows = new Map<string, CloudRow>();
  const transport: Transport = {
    insert: vi.fn(async (owner, s) => { const key = owner + s.id; if (rows.has(key)) throw new SyncError('duplicate', '23505', 409); const value = row(owner, s); rows.set(key, value); return value; }),
    get: vi.fn(async (owner, id) => rows.get(owner + id) ?? null),
    page: vi.fn(async (owner, cursor) => [...rows.values()].filter(r => r.user_id === owner && (!cursor || Date.parse(r.ended_at) < Date.parse(cursor.endedAt) || (r.ended_at === cursor.endedAt && r.id > cursor.id)))
      .sort((a,b) => Date.parse(b.ended_at) - Date.parse(a.ended_at) || a.id.localeCompare(b.id)).slice(0, PAGE_SIZE)),
  };
  return { rows, transport };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-30T01:00:00Z')); });
afterEach(() => vi.useRealTimers());
it('persists locally first, confirms actual response, then restores a drained queue without another INSERT', async () => {
  const m = memory(), p = new Profiles(() => m), remote = server(); p.switchTo(userOwner(A));
  p.store.save(final('one'), 0); expect(p.store.storageLabel('one')).toBe('Ожидает синхронизации');
  const insert = remote.transport.insert;
  remote.transport.insert = vi.fn(async (...args) => {
    expect(JSON.parse(scopedStorage(() => m, userOwner(A)).getItem(STORAGE_KEY)!).history[0].id).toBe('one'); return insert(...args);
  });
  const engine = new SyncEngine(p, remote.transport); await engine.flush(); await engine.flush();
  expect(remote.transport.insert).toHaveBeenCalledOnce(); expect(p.store.storageLabel('one')).toBe('Сохранено в аккаунте');
  const restored = new Profiles(() => m); restored.switchTo(userOwner(A)); expect(restored.pending()).toEqual([]);
  await new SyncEngine(restored, remote.transport).flush(); expect(remote.transport.insert).toHaveBeenCalledOnce();
});
it('retries a committed-but-lost response after reload and verifies the conflicting row before acknowledging', async () => {
  const m = memory(), p = new Profiles(() => m), remote = server(); p.switchTo(userOwner(A)); p.store.save(final('one'), 0);
  const insert = remote.transport.insert;
  remote.transport.insert = vi.fn().mockImplementationOnce(async (...args: Parameters<Transport['insert']>) => { await insert(...args); throw TypeError('network'); }).mockImplementation(insert);
  const old = new SyncEngine(p, remote.transport); await old.flush();
  expect(p.store.syncState('one')).toMatchObject({ status: 'retry', failures: 1 }); old.reset();
  const reloaded = new Profiles(() => m); reloaded.switchTo(userOwner(A)); const engine = new SyncEngine(reloaded, remote.transport);
  await engine.flush(); expect(remote.transport.insert).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2000);
  expect(remote.transport.get).toHaveBeenCalledWith(A, 'one', expect.any(AbortSignal));
  expect(reloaded.store.syncState('one')?.status).toBe('saved'); expect(remote.rows.size).toBe(1);
});
it('never treats a conflicting id with different content as saved or replaces either version', async () => {
  const p = new Profiles(() => memory()), remote = server(); p.switchTo(userOwner(A)); p.store.save(final('one', 1), 0);
  remote.rows.set(A + 'one', row(A, final('one', 2)));
  const engine = new SyncEngine(p, remote.transport); await engine.flush(); await engine.flush();
  expect(p.store.syncState('one')?.status).toBe('error'); expect(p.store.storageLabel('one')).toContain('разные итоги');
  expect(p.store.data.history[0].exercises.pinch.reps).toBe(1);
  expect((remote.rows.get(A + 'one')!.payload as Session).exercises.pinch.reps).toBe(2);
  expect(remote.transport.insert).toHaveBeenCalledOnce();
});
it('permanent errors stop automatic retries, transient errors back off with a bound', async () => {
  const p = new Profiles(() => memory()), remote = server(); p.switchTo(userOwner(A)); p.store.save(final('one'), 0);
  remote.transport.insert = vi.fn(async () => { throw new SyncError('denied', '42501', 403); });
  const engine = new SyncEngine(p, remote.transport); await engine.flush(); await vi.advanceTimersByTimeAsync(600000); await engine.flush();
  expect(remote.transport.insert).toHaveBeenCalledOnce(); expect(p.store.storageLabel('one')).toContain('RLS');
  expect([1,2,3,20].map(retryDelay)).toEqual([2000,4000,8000,60000]);
});
it('offline after app load preserves local finals and sends on reconnect', async () => {
  const p = new Profiles(() => memory()), remote = server(); p.switchTo(userOwner(A)); const engine = new SyncEngine(p, remote.transport);
  engine.setOnline(false); p.store.save(final('offline'), 0); await engine.flush();
  expect(remote.transport.insert).not.toHaveBeenCalled(); expect(p.pending()).toHaveLength(1);
  engine.setOnline(true); await vi.advanceTimersByTimeAsync(0);
  expect(p.store.syncState('offline')?.status).toBe('saved');
});
it('ignores a late A response after switching to B and aborts old requests', async () => {
  const p = new Profiles(() => memory()), remote = server(); p.switchTo(userOwner(A)); p.store.save(final('a'), 0);
  let resolve!: (r: CloudRow) => void;
  remote.transport.insert = vi.fn(() => new Promise(r => { resolve = r; }));
  const engine = new SyncEngine(p, remote.transport), request = engine.flush();
  const signal = vi.mocked(remote.transport.insert).mock.calls[0][2];
  p.switchTo(userOwner(B)); engine.reset(); resolve(row(A, final('a'))); await request;
  expect(signal.aborted).toBe(true); expect(p.store.data.history).toEqual([]); expect(p.pending()).toEqual([]);
  p.switchTo(userOwner(A)); expect(p.pending()).toHaveLength(1); expect(p.store.syncState('a')).toBeUndefined();
});
it('does not accept a delayed history page for the previous account', async () => {
  const p = new Profiles(() => memory()), remote = server(); p.switchTo(userOwner(A));
  let resolve!: (r: CloudRow[]) => void; remote.transport.page = vi.fn(() => new Promise(r => { resolve = r; }));
  const engine = new SyncEngine(p, remote.transport), request = engine.loadMore();
  p.switchTo(userOwner(B)); engine.reset(); resolve([row(A, final('a'))]); await request;
  expect(p.store.data.history).toEqual([]);
});
it('loads chronological pages with ties, unions by owner/id and preserves unsent local records', async () => {
  const p = new Profiles(() => memory()), remote = server(); p.switchTo(userOwner(A)); p.store.save(final('unsent'), 0);
  for (let i = 0; i < 65; i++) { const s = final(String(i).padStart(3, '0')); remote.rows.set(A + s.id, row(A,s)); }
  remote.rows.set(B + 'foreign', row(B, final('foreign')));
  const engine = new SyncEngine(p, remote.transport); await engine.loadMore(); expect(p.store.data.history).toHaveLength(31);
  await engine.loadMore(); await engine.loadMore(); expect(engine.more).toBe(false); expect(p.store.data.history).toHaveLength(66);
  expect(p.pending().map(s => s.id)).toEqual(['unsent']);
  expect(remote.transport.page).toHaveBeenNthCalledWith(2, A, { endedAt: '2026-09-30T00:01:00Z', id: '029' }, expect.any(AbortSignal));
  await engine.loadMore(true); expect(p.store.data.history).toHaveLength(66);
});
it('rejects malformed or foreign cloud rows without falsely acknowledging them', async () => {
  const p = new Profiles(() => memory()), remote = server(); p.switchTo(userOwner(A)); p.store.save(final('one'), 0);
  remote.transport.insert = vi.fn(async () => row(B, final('one')));
  const engine = new SyncEngine(p, remote.transport); await engine.flush(); expect(p.store.syncState('one')?.status).toBe('error');
  remote.transport.page = vi.fn(async () => [row(A, final('valid')), row(B, final('foreign'))]);
  await engine.loadMore(); expect(p.store.data.history.map(s => s.id)).toEqual(['one']);
});
it('quota failure keeps a memory queue and never claims durable local storage or a server save before response', async () => {
  const p = new Profiles(() => ({ getItem: () => null, setItem: () => { throw Error('quota'); } })), remote = server(); p.switchTo(userOwner(A));
  p.store.save(final('memory'), 0); expect(p.store.storageLabel('memory')).toContain('только в памяти');
  const engine = new SyncEngine(p, remote.transport); await engine.flush(); expect(p.store.storageLabel('memory')).toBe('Сохранено в аккаунте');
  expect(p.store.notice).toContain('не сохраняется');
});
it('guest never sends; explicit selected imports preserve id, provenance and deduplication across reload', async () => {
  const m = memory(), p = new Profiles(() => m), remote = server(); p.store.save(final('guest1'), 0); p.store.save(final('guest2'), 1);
  const engine = new SyncEngine(p, remote.transport); await engine.flush(); await engine.loadMore(); expect(remote.transport.insert).not.toHaveBeenCalled();
  p.switchTo(userOwner(A)); engine.reset(); expect(p.store.data.history).toEqual([]);
  expect(p.importGuest(['guest1','guest1'])).toEqual({ added: 1, same: 0, conflicts: 0 });
  await engine.flush(); expect(p.store.syncState('guest1')).toMatchObject({ status: 'saved', guestImported: true });
  const reload = new Profiles(() => m); reload.switchTo(userOwner(A));
  expect(reload.importGuest(['guest1'])).toEqual({ added: 0, same: 1, conflicts: 0 }); expect(reload.pending()).toEqual([]);
  expect(reload.guestHistory()).toHaveLength(2); reload.switchTo(userOwner(B)); expect(reload.pending()).toEqual([]);
});
it('exports only validated aggregates and imports into guest without forged receipts, duplicates or silent conflict replacement', () => {
  const store = new ProgressStore(() => memory()), s = final('one'), text = exportAggregates([s]);
  expect(text).not.toMatch(/"(?:access_token|sync|landmarks)"\s*:/); expect(importAggregates(store, text)).toBe(1); expect(importAggregates(store, text)).toBe(0);
  expect(() => importAggregates(store, exportAggregates([final('two'), final('one', 1)]))).toThrow('Конфликт'); expect(store.data.history).toHaveLength(1);
  const extra = JSON.parse(text); extra.sessions[0].landmarks = [];
  expect(() => parseAggregates(JSON.stringify(extra))).toThrow('лишние поля');
  expect(() => parseAggregates('x'.repeat(MAX_TRANSFER_BYTES + 1))).toThrow('5 MiB');
  expect(() => parseAggregates('{')).toThrow('JSON');
  store.account = true; expect(() => importAggregates(store, text)).toThrow('гостю');
});
it('canonical equality ignores object key order, but not attempt/sequence order', () => {
  expect(sameSession({ a:1,b:2 }, { b:2,a:1 })).toBe(true);
  expect(sameSession({ sequence:[8,12] }, { sequence:[12,8] })).toBe(false);
});
it('retries temporary page failure with delay and does not remove locally queued sessions', async () => {
  const p = new Profiles(() => memory()), remote = server(); p.switchTo(userOwner(A)); p.store.save(final('local'), 0);
  remote.transport.page = vi.fn().mockRejectedValueOnce(new SyncError('busy', '', 503)).mockResolvedValueOnce([row(A, final('remote'))]);
  const engine = new SyncEngine(p, remote.transport); await engine.loadMore();
  expect(p.store.data.history.map(s => s.id)).toEqual(['local']);
  await vi.advanceTimersByTimeAsync(1999); expect(remote.transport.page).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(remote.transport.page).toHaveBeenCalledTimes(2);
  expect(p.store.data.history).toHaveLength(2); expect(p.pending().map(s => s.id)).toEqual(['local']);
});
it('preserves the source when saved queue metadata is malformed', () => {
  const m = memory();
  const raw = JSON.stringify({ schemaVersion: 3, current: null, history: [final('one')], sync: { one: { status: 'saved', failures: -1, retryAt: 0 } } });
  m.setItem(STORAGE_KEY, raw); const store = new ProgressStore(() => m);
  expect(store.durable).toBe(false); expect(store.notice).toContain('повреждены');
  store.save(final('two'), 0); expect(m.getItem(STORAGE_KEY)).toBe(raw); expect(store.data.history).toHaveLength(2);
});

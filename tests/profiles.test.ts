import { expect, it } from 'vitest';
import { Profiles, userOwner } from '../src/profiles';
import { createSession, finishSession } from '../src/session';
import { STORAGE_KEY } from '../src/storage';
const A = userOwner('11111111-1111-4111-8111-111111111111'), B = userOwner('22222222-2222-4222-8222-222222222222');
const final = (id: string) => finishSession(createSession(id, '2026-09-30T00:00:00Z'), 'stopped', '2026-09-30T00:01:00Z');
function memory() { const values = new Map<string, string>(); return { values, getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } }; }
it('preserves old guest keys without moving them to an account and scopes queues by owner', () => {
  const m = memory(), p = new Profiles(() => m);
  p.store.save(final('guest'), 0, true); const guestRaw = m.getItem(STORAGE_KEY);
  expect(p.pending()).toEqual([]); p.switchTo(A); expect(p.store.data.history).toEqual([]);
  p.store.save(final('same-id'), 1, true); expect(p.pending()).toMatchObject([{ owner: A, id: 'same-id' }]);
  const aStore = p.store; p.switchTo(B); expect(p.store.data.history).toEqual([]); expect(p.pending()).toEqual([]);
  p.store.save(final('same-id'), 2, true); expect(p.pending()[0].owner).toBe(B);
  aStore.save(final('late-local-save'), 3, true); expect(p.store.data.history).toHaveLength(1);
  p.switchTo('guest'); expect(m.getItem(STORAGE_KEY)).toBe(guestRaw); expect(p.store.data.history[0].id).toBe('guest');
  const reload = new Profiles(() => m); reload.switchTo(A);
  expect(reload.pending().map(a => a.id)).toEqual(['late-local-save', 'same-id']);
  expect(reload.pending().every(a => a.owner === A)).toBe(true);
});
it('rejects stale callbacks across logout and A to B to A transitions', () => {
  const p = new Profiles(() => memory()); p.switchTo(A); const request = p.ticket();
  p.switchTo(B); expect(p.acceptResponse(request, () => { throw Error('applied stale response'); })).toBe(false);
  p.switchTo(A); expect(p.accepts(request)).toBe(false); expect(p.pending(request)).toEqual([]);
  const current = p.ticket(); expect(p.acceptResponse(current, store => store.save(final('a'), 0))).toBe(true);
  p.switchTo('guest'); expect(p.accepts(current)).toBe(false);
});
it('keeps unsaved account data in memory when quota fails without showing it in another profile', () => {
  const p = new Profiles(() => ({ getItem: () => null, setItem: () => { throw Error('quota'); } }));
  p.switchTo(A); p.store.save(final('private-a'), 0); p.switchTo(B);
  expect(p.store.data.history).toEqual([]); p.switchTo(A); expect(p.store.data.history[0].id).toBe('private-a');
});
it('does not copy an active attempt or current session on identity changes', () => {
  const m = memory(), p = new Profiles(() => m); p.switchTo(A);
  p.store.save(createSession('active-a'), 0); p.switchTo(B); expect(p.store.data.current).toBeNull();
  const reload = new Profiles(() => m); reload.switchTo(A); expect(reload.store.data.current?.id).toBe('active-a');
  expect(reload.store.data.current?.paused).toBe(true);
});

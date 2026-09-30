import { ProgressStore } from './storage';
import type { Session } from './session';
export type Owner = 'guest' | `user:${string}`;
export type StoragePort = Pick<Storage, 'getItem' | 'setItem'>;
export function userOwner(id: string | null): Owner {
  if (id === null) return 'guest';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw Error('Invalid user identity');
  return `user:${id}`;
}
export function scopedStorage(getStorage: () => StoragePort, owner: Owner): StoragePort {
  const storage = getStorage();
  // Existing unscoped keys are the guest namespace, never an account migration source.
  const key = (name: string) => owner === 'guest' ? name : `neurohand:profile:${owner}:${name}`;
  return { getItem: name => storage.getItem(key(name)), setItem: (name, value) => storage.setItem(key(name), value) };
}
export type OwnerTicket = { owner: Owner; generation: number };
export type PendingResult = { owner: Exclude<Owner, 'guest'>; id: string; payload: Session };
export class Profiles {
  owner: Owner = 'guest';
  private generation = 0;
  private stores = new Map<Owner, ProgressStore>();
  private getStorage: () => StoragePort;
  constructor(getStorage: () => StoragePort = () => window.localStorage) { this.getStorage = getStorage; }
  private forOwner(owner: Owner) {
    let store = this.stores.get(owner);
    if (!store) { store = new ProgressStore(() => scopedStorage(this.getStorage, owner)); store.account = owner !== 'guest'; this.stores.set(owner, store); }
    return store;
  }
  get store() { return this.forOwner(this.owner); }
  guestHistory(): Session[] { return structuredClone(this.forOwner('guest').data.history); }
  importGuest(ids: string[], ticket = this.ticket()): { added: number; same: number; conflicts: number } {
    const result = { added: 0, same: 0, conflicts: 0 };
    if (!this.accepts(ticket) || ticket.owner === 'guest') return result;
    for (const id of new Set(ids)) {
      const record = this.forOwner('guest').data.history.find(s => s.id === id);
      if (!record) continue;
      const merged = this.store.mergeFinal(record, false, true);
      if (merged === 'conflict') result.conflicts++; else result[merged]++;
    }
    return result;
  }
  switchTo(owner: Owner) { if (owner !== this.owner) { this.generation++; this.owner = owner; } return this.store; }
  ticket(): OwnerTicket { return { owner: this.owner, generation: this.generation }; }
  accepts(ticket: OwnerTicket) { return ticket.owner === this.owner && ticket.generation === this.generation; }
  /** Pending finals and their retry state are persisted atomically with the owner's history. */
  pending(ticket: OwnerTicket = this.ticket()): PendingResult[] {
    if (!this.accepts(ticket) || ticket.owner === 'guest') return [];
    const owner = ticket.owner;
    return this.store.data.history.filter(s => !['saved', 'error'].includes(this.store.syncState(s.id)?.status ?? 'pending')).map(payload => ({ owner, id: payload.id, payload: structuredClone(payload) }));
  }
  acceptResponse(ticket: OwnerTicket, apply: (store: ProgressStore) => void): boolean {
    if (!this.accepts(ticket)) return false;
    apply(this.store); return true;
  }
}

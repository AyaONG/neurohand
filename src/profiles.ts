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
  get store() {
    let store = this.stores.get(this.owner);
    if (!store) { store = new ProgressStore(() => scopedStorage(this.getStorage, this.owner)); this.stores.set(this.owner, store); }
    return store;
  }
  switchTo(owner: Owner) { if (owner !== this.owner) { this.generation++; this.owner = owner; } return this.store; }
  ticket(): OwnerTicket { return { owner: this.owner, generation: this.generation }; }
  accepts(ticket: OwnerTicket) { return ticket.owner === this.owner && ticket.generation === this.generation; }
  /** No network sender in stage 12. Durable outbox is a view of this owner's immutable finals.
   * Reconstruction after reload is atomic with local history; guest results never enter it.
   * Stage 13 must add server acknowledgements before removing anything from this view. */
  pending(ticket: OwnerTicket = this.ticket()): PendingResult[] {
    if (!this.accepts(ticket) || ticket.owner === 'guest') return [];
    const owner = ticket.owner;
    return this.store.data.history.map(payload => ({ owner, id: payload.id, payload: structuredClone(payload) }));
  }
  acceptResponse(ticket: OwnerTicket, apply: (store: ProgressStore) => void): boolean {
    if (!this.accepts(ticket)) return false;
    apply(this.store); return true;
  }
}

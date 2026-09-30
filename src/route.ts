import { createSession, createOppositionSession, createRingSession, type Session } from './session';
import { isPairKey, type PairKey } from './opposition';
import { RING_TIPS, type RingTip } from './ring';
import { withFlow } from './flow';
export type Route = { trainingRunId: string; index: number; blocks: { id: string; mode: Session['mode'] }[]; pairs: PairKey[]; ringTip: RingTip };
export function parseRoute(v: any): Route | undefined {
  const id = (s: unknown): s is string => typeof s === 'string' && s.length > 0 && s.length <= 200;
  if (!v || !id(v.trainingRunId) || !Array.isArray(v.blocks) || !v.blocks.length || v.blocks.length > 3 ||
      !Number.isInteger(v.index) || v.index < 0 || v.index >= v.blocks.length ||
      v.blocks.some((b: any) => !b || !id(b.id) || !['guided','opposition','ring'].includes(b.mode)) ||
      new Set(v.blocks.map((b: any) => b.id)).size !== v.blocks.length || new Set(v.blocks.map((b: any) => b.mode)).size !== v.blocks.length ||
      !Array.isArray(v.pairs) || !v.pairs.length || v.pairs.length > 10 || !v.pairs.every(isPairKey) || new Set(v.pairs).size !== v.pairs.length || !RING_TIPS.includes(v.ringTip)) return;
  return { trainingRunId: v.trainingRunId, index: v.index, blocks: v.blocks.map((b: any) => ({ id: b.id, mode: b.mode })), pairs: [...v.pairs], ringTip: v.ringTip };
}
export function routeSession(route: Route, automatic: boolean, hand: Session['hand'], now = new Date().toISOString()): Session {
  const block = route.blocks[route.index];
  const s = block.mode === 'guided' ? createSession(block.id, now) : block.mode === 'ring' ? createRingSession(route.ringTip, block.id, now) : createOppositionSession(route.pairs, block.id, now);
  const result = withFlow({ ...s, hand }, automatic);
  return { ...result, attempts: { ...result.attempts!, route } };
}
export function nextRouteSession(s: Session, history: Session[], now = new Date().toISOString()): Session | null {
  const r = s.attempts?.route;
  if (!r || s.status !== 'completed' || r.index + 1 === r.blocks.length) return null;
  const route = { ...r, index: r.index + 1 };
  if (history.some(h => h.id === route.blocks[route.index].id)) return null;
  return routeSession(route, s.attempts!.flow!.automatic, s.hand, now);
}
export function routeConditions(s: Session) {
  const r = s.attempts?.route;
  return r ? [r.index, r.blocks.map(b => b.mode), r.pairs, r.ringTip] : null;
}

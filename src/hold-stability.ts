import type { HoldState } from './fsm';
export const HOLD_RULES_VERSION = 'hold-stable-v2';
export const HOLD_RECOGNITION = 'landmarks-v2-hold-stable150';
// At most 150 ms in one uncertain episode, 250 ms total per hold. Invalid time never accrues.
export type HoldStability = { badSince: number | null; noiseMs: number; previousGood: boolean; targetKey: string | null };
export const emptyHoldStability = (): HoldStability => ({ badSince:null, noiseMs:0, previousGood:false, targetKey:null });
export type HoldReset = 'openness' | 'outside' | 'tracking' | 'quality' | 'frame_gap' | 'resize' | 'target_change' | 'reinitialize' | 'goal_timeout';
export function stableHold(hold: HoldState, old: HoldStability, now: number, dt: number, good: boolean, hard: boolean, reason: HoldReset, targetKey: string) {
 let state={...old}, reset: HoldReset | null=null;
 if(old.targetKey !== null && old.targetKey !== targetKey) { hold={...hold,holdMs:0};state=emptyHoldStability();reset='target_change'; }
 state.targetKey=targetKey;
 if(!good) {
  state.badSince ??= now;state.noiseMs += Math.max(0,dt);state.previousGood=false;
  if(hard || now-state.badSince >=150 || state.noiseMs>250) { if(hold.holdMs>0)reset=reason;hold={...hold,holdMs:0}; }
  return {hold,state,reset,measured:false};
 }
 if(state.badSince !== null && (now-state.badSince>=150 || state.noiseMs>250)) {if(hold.holdMs>0)reset=reason;hold={...hold,holdMs:0};state.noiseMs=0;}
 if(reset) state.noiseMs=0;
 const amount=state.previousGood && dt>=0 && dt<=250 ? dt : 0;
 const elapsed=hold.holdMs+amount;
 hold=elapsed>=2000 ? {holdMs:0,reps:hold.reps+1} : {...hold,holdMs:elapsed};
 state={...state,badSince:null,previousGood:true,noiseMs:hold.holdMs===0?0:state.noiseMs};
 return {hold,state,reset,measured:true};
}

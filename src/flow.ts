import type { Session } from './session';
import type { Program, ProgramFrame } from './program';
import { closeActive } from './attempts';
import { goalRows } from './goals';
import { settleOpposition, readOpposition, currentPair } from './opposition';
import { settleRing } from './ring';

export const FLOW_RULES = Object.freeze({ version: 'hands-free-v1', goalMs: 20000, failedLimit: 2, unscorableLimit: 2, feedbackMs: 900, transitionMs: 3000, recoveryMs: 3000 });
export type Closure = 'success' | 'attempt_limit' | 'time_limit' | 'unscorable_limit' | 'manual_skip';
export const CLOSURE_LABELS: Record<Closure, string> = { success: 'Выполнено', attempt_limit: 'Лимит двух оценённых попыток', time_limit: 'Время цели истекло', unscorable_limit: 'Не удалось оценить', manual_skip: 'Пропущено вручную' };
export type GoalProgress = { goalId: string; usableMs: number; ready: boolean; reason: Closure | null; endedAt: string | null };
export type Flow = { version: 'hands-free-v1'; automatic: boolean; cursor: number; goals: GoalProgress[]; transitionMs: number; visibilityHelp: boolean };
export function withFlow(s: Session, automatic = true): Session {
  if (!s.attempts?.runs || s.attempts.flow) return s;
  return { ...s, attempts: { ...s.attempts, flow: { version: FLOW_RULES.version, automatic, cursor: 0,
    goals: s.attempts.runs.flatMap(r => r.goalIds.map(goalId => ({ goalId, usableMs: 0, ready: false, reason: null, endedAt: null }))),
    transitionMs: 0, visibilityHelp: false } } };
}
export const transitionDuration = (flow: Flow) => FLOW_RULES.transitionMs + (flow.goals[flow.cursor].reason === 'success' ? FLOW_RULES.feedbackMs : 0);
export function parseFlow(v: any, ids: string[]): Flow | undefined {
  if (!v || v.version !== FLOW_RULES.version || typeof v.automatic !== 'boolean' || !Number.isInteger(v.cursor) || v.cursor < 0 || v.cursor >= ids.length ||
      !Array.isArray(v.goals) || v.goals.length !== ids.length || typeof v.visibilityHelp !== 'boolean' || !Number.isFinite(v.transitionMs) || v.transitionMs < 0 || v.transitionMs > FLOW_RULES.transitionMs + FLOW_RULES.feedbackMs) return;
  const goals: GoalProgress[] = [];
  for (const [i,g] of v.goals.entries()) {
    if (!g || g.goalId !== ids[i] || !Number.isFinite(g.usableMs) || g.usableMs < 0 || g.usableMs > FLOW_RULES.goalMs || typeof g.ready !== 'boolean' ||
        (g.reason !== null && !Object.hasOwn(CLOSURE_LABELS,g.reason)) || (g.reason === null ? g.endedAt !== null : typeof g.endedAt !== 'string' || !Number.isFinite(Date.parse(g.endedAt))) ||
        (i < v.cursor && !g.reason) || (i > v.cursor && (g.reason || g.ready || g.usableMs))) return;
    goals.push({ goalId: g.goalId, usableMs: g.usableMs, ready: g.ready, reason: g.reason, endedAt: g.endedAt });
  }
  if ((!goals[v.cursor].reason && (v.transitionMs || v.visibilityHelp)) || (goals[v.cursor].reason !== 'success' && v.transitionMs > FLOW_RULES.transitionMs)) return;
  return { version: FLOW_RULES.version, automatic: v.automatic, cursor: v.cursor, goals, transitionMs: v.transitionMs, visibilityHelp: v.visibilityHelp };
}
export function closeGoal(s: Session, reason: Closure, wall: string): Session {
  const f = s.attempts?.flow;
  if (!f || f.goals[f.cursor].reason || s.status !== 'in_progress') return s;
  const goals = f.goals.map((g,i) => i === f.cursor ? { ...g, reason, endedAt: wall } : g);
  const visibilityHelp = reason === 'unscorable_limit' && f.cursor > 0 && goals[f.cursor - 1].reason === 'unscorable_limit';
  return { ...s, attempts: { ...s.attempts!, flow: { ...f, goals, transitionMs: 0, visibilityHelp } } };
}
export function settleFlow(s: Session, wall: string): Session {
  const f = s.attempts?.flow;
  if (!f || s.status !== 'in_progress') return s;
  const row = goalRows(s.attempts)!.find(g => g.goalId === f.goals[f.cursor].goalId)!;
  const reason: Closure | null = row.completed ? 'success' : row.attempts.some(a => a.endReason === 'skip') ? 'manual_skip' :
    !f.automatic ? null : row.attempts.filter(a => a.outcome === 'partial' || a.outcome === 'incomplete').length >= FLOW_RULES.failedLimit ? 'attempt_limit' :
    row.attempts.filter(a => a.outcome === 'unscorable').length >= FLOW_RULES.unscorableLimit ? 'unscorable_limit' : null;
  return reason ? closeGoal(s, reason, wall) : s;
}
export function usableFrame(p: Program, f: ProgramFrame): boolean {
  if (!f.fullHand || !f.geometry) return false;
  if (p.session.mode === 'opposition') return readOpposition(f.geometry, currentPair(p.session), p.oppositionState.baselineDistances).error?.code !== 'AMBIGUOUS_PAIR' && p.oppositionState.ambiguitySince === null;
  return p.session.mode !== 'ring' || !!f.ring?.point;
}
/** Called around the unchanged exercise controllers. All accumulated clocks use adjacent usable frames. */
export function afterFlow(old: Program, p: Program, frame: ProgramFrame): Program {
  let s = settleFlow(p.session, frame.wallTime), f = s.attempts!.flow!;
  let goal = f.goals[f.cursor];
  const valid = usableFrame(p, frame) && usableFrame(old, frame) && old.lastTimestamp !== null && old.lastValidTimestamp === old.lastTimestamp && frame.timestampMs - old.lastTimestamp <= 250;
  const dt = valid && old.phase !== 'paused' && old.phase !== 'intro' ? Math.max(0, frame.timestampMs - old.lastTimestamp!) : 0;
  if (!goal.reason && !s.paused) {
    goal = { ...goal, ready: goal.ready || p.phase === 'exercise' };
    if (f.automatic && old.session.attempts!.flow!.goals[f.cursor].ready && old.phase !== 'transition') goal.usableMs = Math.min(FLOW_RULES.goalMs, goal.usableMs + dt);
    f = { ...f, goals: f.goals.map((g,i) => i === f.cursor ? goal : g) };
    s = { ...s, attempts: { ...s.attempts!, flow: f } };
    if (f.automatic && goal.usableMs === FLOW_RULES.goalMs) {
      s = settleRing(settleOpposition({ ...s, attempts: closeActive(s.attempts, 'timeout', frame.wallTime) }));
      s = closeGoal(s, 'time_limit', frame.wallTime);
    }
  }
  return { ...p, session: s, phase: s.attempts!.flow!.goals[f.cursor].reason && !s.paused ? 'transition' : p.phase };
}

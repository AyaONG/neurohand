import type { Session } from './session';
import { HOLD_RECOGNITION } from './hold-stability';
/** The same goal, not the number of successes, selects both measured and drawn target. */
export function holdGoalIndex(s: Session): number {
 const f=s.attempts?.flow, run=s.attempts?.runs?.find(r=>r.exerciseId==='hold');
 if(f && run && s.currentExercise==='hold' && s.recognitionVersion===HOLD_RECOGNITION) {
  const i=run.goalIds.indexOf(f.goals[f.cursor].goalId);if(i>=0)return i;
 }
 return s.exercises.hold.reps;
}

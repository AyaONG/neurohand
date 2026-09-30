import type { Attempt, AttemptLog } from './attempts';
import type { ExerciseId } from './types';
import { END_REASONS } from './progress';
export type MovementEvent = { id: string; exercise: ExerciseId; at: number; completed: boolean; text: string };
export function movementEvent(a: Attempt, at: number): MovementEvent | null {
  if (!a.outcome || a.outcome === 'cancelled') return null;
  const m = a.metrics;
  const metric = m.kind === 'ring' ? `${m.marks} / 12 отметок${m.returned ? ', с возвратом' : ', возврат не подтверждён'}` :
    m.kind === 'hold' ? `${(m.bestHoldMs / 1000).toFixed(1)} / ${(m.targetMs / 1000).toFixed(1)} с удержания` :
    m.kind === 'closure' ? `сближение ${Math.round(m.progress * 100)}% пути к заданному расстоянию` : '';
  return { id: a.attemptId, exercise: a.exerciseId, at, completed: a.outcome === 'completed',
    text: a.outcome === 'completed' ? 'Выполнено' : a.outcome === 'unscorable' ? `Не удалось оценить движение · ${END_REASONS[a.endReason!]}` : `Попытка сохранена · ${metric}` };
}
/** The initial snapshot is already seen: reload/account switches never replay old rewards. */
export class MovementEvents {
  private seen: Set<string>;
  current: MovementEvent | null = null;
  constructor(log: AttemptLog | null) { this.seen = new Set(log?.records.map(a => a.attemptId)); }
  update(log: AttemptLog | null, at: number) {
    for (const a of log?.records ?? []) if (!this.seen.has(a.attemptId)) {
      this.seen.add(a.attemptId);
      const event = movementEvent(a, at);
      if (event) this.current = event;
    }
    return this.current;
  }
}

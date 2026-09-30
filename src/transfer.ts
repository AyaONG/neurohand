import { parseSession, type ProgressStore } from './storage';
import { sameSession } from './session-equality';
import type { Session } from './session';
export const MAX_TRANSFER_BYTES = 5 * 1024 * 1024;
export function exportAggregates(sessions: Session[]): string {
  const text = JSON.stringify({ format: 'neurohand-aggregates', version: 1, sessions }, null, 2);
  parseAggregates(text); return text;
}
export function parseAggregates(text: string): Session[] {
  if (new TextEncoder().encode(text).length > MAX_TRANSFER_BYTES) throw Error('Файл превышает 5 MiB');
  let value: any; try { value = JSON.parse(text); } catch { throw Error('Некорректный JSON'); }
  if (!value || value.format !== 'neurohand-aggregates' || value.version !== 1 || !Array.isArray(value.sessions) || value.sessions.length > 1000 ||
      Object.keys(value).some(k => !['format', 'version', 'sessions'].includes(k))) throw Error('Неизвестный формат экспорта');
  const seen = new Map<string, Session>();
  for (const raw of value.sessions) {
    const s = parseSession(raw);
    if (!s || s.status === 'in_progress' || s.id.length > 200 || !sameSession(s, raw)) throw Error('Файл содержит невалидные данные или лишние поля');
    if (seen.has(s.id) && !sameSession(seen.get(s.id), s)) throw Error('Одинаковый id с разными итогами');
    seen.set(s.id, s);
  }
  return [...seen.values()];
}
/** Caller must be in guest mode. Preflight the entire file before changing any local record. */
export function importAggregates(store: ProgressStore, text: string): number {
  if (store.account) throw Error('Импорт файла доступен только гостю');
  const sessions = parseAggregates(text);
  for (const s of sessions) {
    const existing = store.data.history.find(p => p.id === s.id);
    if (store.data.current?.id === s.id || (existing && !sameSession(existing, s))) throw Error('Конфликт id с локальным занятием; импорт не выполнен');
  }
  let added = 0;
  for (const s of sessions) if (store.mergeFinal(s) === 'added') added++;
  return added;
}

/** Build-time switches affect starting/resuming only; stored results remain readable. */
export function modeEnabled(mode: string, env = import.meta.env): boolean {
  if (mode === 'opposition') return env.VITE_ENABLE_OPPOSITION !== 'false';
  if (mode === 'ring') return env.VITE_ENABLE_RING !== 'false';
  return mode === 'guided';
}

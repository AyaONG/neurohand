/** Continuous visual timers must not flood the screen reader's event channel. */
export function spokenHint(text: string): string {
  if (text.startsWith('Удерживай ·')) return 'Удерживай открытую ладонь в цели';
  if (text.startsWith('Держи открытую ладонь ·')) return 'Держи открытую ладонь для подготовки';
  if (text.startsWith('Приготовься ·')) return 'Ладонь готова. Скоро начнём';
  return text;
}

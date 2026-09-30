import { describe, it, expect } from 'vitest';
import { spokenHint } from '../src/presentation';

describe('screen reader event messages', () => {
  it('announces one instruction across changing hold and preparation timers', () => {
    const holds = Array.from({ length: 20 }, (_, i) => spokenHint(`Удерживай · ${(i / 10).toFixed(1)} / 2,0 с`));
    expect(new Set(holds).size).toBe(1);
    expect(spokenHint('Держи открытую ладонь · 0.1 / 2 с')).toBe(spokenHint('Держи открытую ладонь · 1.9 / 2 с'));
    expect(spokenHint('Приготовься · 1')).toBe('Ладонь готова. Скоро начнём');
  });
  it('preserves new successes and actionable error messages', () => {
    for (const message of ['✓ Захват засчитан · 1 из 5', '✓ Захват засчитан · 2 из 5', 'Рука не видна. Верни ладонь в кадр', 'Согни мизинец вместе с остальными пальцами']) {
      expect(spokenHint(message)).toBe(message);
    }
  });
});

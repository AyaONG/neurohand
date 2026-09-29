import { HandGeometry } from "./geometry";
import { Reading, Calibration } from "./types";

export const PINCH_CLOSE = 0.28;   // < = сомкнуты
export const PINCH_OPEN  = 0.50;   // > = разомкнуты

export const GRIP_CLOSE_RATIO = 0.5;
export const GRIP_OPEN_RATIO = 0.85;

export function readPinch(g: HandGeometry): Reading {
  const good = g.nd(4, 8);
  const wrongTips = [12, 16, 20].filter(t => g.nd(4, t) < PINCH_CLOSE);

  if (wrongTips.length && good > PINCH_CLOSE) {
    return {
      open: false, closed: false,
      error: {
        code: "WRONG_FINGER",
        joints: [wrongTips[0]],
        message: "Ошибочный палец. Используйте указательный",
      },
    };
  }
  return {
    open: good > PINCH_OPEN && wrongTips.length === 0,
    closed: good < PINCH_CLOSE,
    error: null,
  };
}

export function readGrip(g: HandGeometry, cal: Calibration): Reading {
  const closeThr = cal.openCurl * GRIP_CLOSE_RATIO;
  const openThr  = cal.openCurl * GRIP_OPEN_RATIO;
  const tips = [8, 12, 16, 20];
  const curls = tips.map(t => g.curl(t));
  const folded = curls.map(c => c < closeThr);

  const threeFoldedPinkyNot = folded[0] && folded[1] && folded[2] && !folded[3];
  if (threeFoldedPinkyNot) {
    return {
      open: false, closed: false,
      error: { code: "PINKY_INCOMPLETE", joints: [20], message: "Дожмите мизинец" },
    };
  }
  return {
    open: curls.every(c => c > openThr),
    closed: folded.every(Boolean),
    error: null,
  };
}

/** Нормированное раскрытие 0..1 для размера шара в упражнении 2 */
export function gripOpenness(g: HandGeometry, cal: Calibration): number {
  const avg = [8, 12, 16, 20].reduce((s, t) => s + g.curl(t), 0) / 4;
  return Math.min(1, Math.max(0, (avg - cal.openCurl * GRIP_CLOSE_RATIO) / (cal.openCurl * GRIP_CLOSE_RATIO)));
}

export function calibrate(samples: HandGeometry[]): Calibration {
  const vals = samples.map(g => [8, 12, 16, 20].reduce((s, t) => s + g.curl(t), 0) / 4);
  return { openCurl: vals.reduce((a, b) => a + b, 0) / vals.length };
}

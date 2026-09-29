# NeuroHand — инструкция по сборке (Admit Hackathon, кейс «Motion»)

**Дедлайн:** 30 сентября, 15:00 (Астана). Расписание ниже считается от дедлайна назад, не от «40 часов».

---

## 0. Что меняем относительно исходной спецификации

| # | Слабое место | Почему это риск | Решение |
|---|---|---|---|
| 1 | Расчёт на 40 часов | Реального времени меньше суток | Расписание T-минус (раздел 9), жёсткий список «что режем» (раздел 10) |
| 2 | «Ширина ладони» (5–17) как масштаб | При повороте кисти ребром ширина схлопывается, все пороги ломаются | Масштаб = расстояние 0–9 (запястье → основание среднего пальца) |
| 3 | Нет сглаживания и гистерезиса | Трекинг дрожит, счётчик мигает, ошибка появляется/исчезает | Два порога (закрыт/открыт) + подтверждение N кадров подряд |
| 4 | Три модуля без общего контракта | Два человека, три ИИ-промпта → код не стыкуется | Сначала `types.ts` вместе (30 мин), потом параллельная работа |
| 5 | Тест на двух людях в конце | Если пороги не работают, чинить уже нечем | Калибровка открытой ладони в приложении + тест на 2 руках в блоке T-9 |

---

## 1. Стек (фиксируем, не обсуждаем)

| Слой | Выбор |
|---|---|
| Сборка | Vite + TypeScript, без React (меньше кода, меньше багов) |
| Трекинг | `@mediapipe/tasks-vision`, `HandLandmarker`, 1 рука |
| Отрисовка | Один `<canvas>` поверх `<video>` |
| Хранение сессии | `localStorage`, только счётчики (никакого видео) |
| Деплой | Vercel/Netlify (HTTPS нужен для камеры) или `localhost` |

```bash
npm create vite@latest neurohand -- --template vanilla-ts
cd neurohand
npm i @mediapipe/tasks-vision
mkdir -p public/models public/wasm
cp node_modules/@mediapipe/tasks-vision/wasm/* public/wasm/
curl -L -o public/models/hand_landmarker.task \
  https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
npm run dev
```

Модель и wasm лежат локально: приложение не зависит от CDN на защите и обрабатывает кадры только в браузере.

---

## 2. Структура проекта

```
src/
  types.ts            # контракты (пишете вместе, первым делом)
  camera.ts           # getUserMedia + MediaPipe
  geometry.ts         # HandGeometry (Модуль 1)
  validator.ts        # ExerciseValidator (Модуль 2)
  fsm.ts              # state machine + hold-логика (Модуль 3a)
  draw.ts             # drawSmartHand (Модуль 3b)
  session.ts          # счётчики, localStorage
  main.ts             # цикл, UI, экраны
  debug.ts            # оверлей с живыми числами
tests/
  geometry.test.ts    # на фикстурах landmarks
  fixtures/           # JSON-кадры, снятые кнопкой Dump
```

---

## 3. Контракты (`src/types.ts`) — пишете вместе

```ts
export type Landmark = { x: number; y: number; z: number };
export type Point = { x: number; y: number };

export type ExerciseId = "pinch" | "grip" | "hold";
export type ErrorCode = "WRONG_FINGER" | "PINKY_INCOMPLETE";

export type HandError = {
  code: ErrorCode;
  joints: number[];   // индексы landmarks, которые подсветить красным
  message: string;    // текст подсказки
};

// Единый выход валидатора для FSM и отрисовки
export type Reading = {
  open: boolean;
  closed: boolean;
  error: HandError | null;
};

export type Phase = "WAIT_OPEN" | "ARMED" | "CONFIRMED";
export type FsmState = { phase: Phase; reps: number; stable: number };

export type Calibration = { openCurl: number }; // средний curl при открытой ладони
```

Индексы MediaPipe: 0 запястье; большой 1–4; указательный 5–8; средний 9–12; безымянный 13–16; мизинец 17–20. Кончики: 4, 8, 12, 16, 20. Основания (MCP): 5, 9, 13, 17.

---

## 4. Модуль 1 — `geometry.ts`

```ts
import { Landmark, Point } from "./types";

export class HandGeometry {
  readonly pts: Point[];      // в пикселях, БЕЗ зеркалирования
  readonly handSize: number;  // расстояние 0–9

  constructor(lm: Landmark[], w: number, h: number) {
    this.pts = lm.map(p => ({ x: p.x * w, y: p.y * h }));
    this.handSize = this.dist(0, 9);
  }

  dist(a: number, b: number): number {
    return Math.hypot(this.pts[a].x - this.pts[b].x, this.pts[a].y - this.pts[b].y);
  }

  /** Расстояние, нормированное на размер руки */
  nd(a: number, b: number): number {
    return this.dist(a, b) / this.handSize;
  }

  palmCenter(): Point {
    const ids = [0, 5, 9, 13, 17];
    return {
      x: ids.reduce((s, i) => s + this.pts[i].x, 0) / ids.length,
      y: ids.reduce((s, i) => s + this.pts[i].y, 0) / ids.length,
    };
  }

  /** Насколько кончик далеко от центра ладони (0 = прижат, ~1+ = вытянут) */
  curl(tip: number): number {
    const c = this.palmCenter();
    return Math.hypot(this.pts[tip].x - c.x, this.pts[tip].y - c.y) / this.handSize;
  }

  isFingerFolded(tip: number, threshold: number): boolean {
    return this.curl(tip) < threshold;
  }
}
```

**Почему пиксели, а не нормализованные:** MediaPipe отдаёт x, y в долях кадра. На кадре 16:9 одинаковые доли по x и y — разные физические расстояния. Умножение на ширину/высоту убирает искажение.

**Промпт для Codex (Модуль 1):**

> Напиши TypeScript-класс `HandGeometry` без зависимостей от React/DOM. Конструктор принимает массив из 21 landmark MediaPipe (x, y, z в диапазоне 0–1) и размеры кадра w, h, переводит точки в пиксели. Методы: `dist(a,b)`, `nd(a,b)` (расстояние, делённое на dist(0,9)), `palmCenter()` (среднее точек 0,5,9,13,17), `curl(tip)` (расстояние кончика до центра ладони / dist(0,9)), `isFingerFolded(tip, threshold)`. Напиши unit-тесты на vitest с двумя синтетическими руками разного масштаба: результаты `nd` и `curl` должны совпадать.

---

## 5. Модуль 2 — `validator.ts`

Пороги нормированы на размер руки, поэтому работают для разных рук. Калибровка подстраивает только «открытую» границу хвата.

```ts
import { HandGeometry } from "./geometry";
import { Reading, Calibration } from "./types";

const PINCH_CLOSE = 0.28;   // < = сомкнуты
const PINCH_OPEN  = 0.50;   // > = разомкнуты

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
  const closeThr = cal.openCurl * 0.5;
  const openThr  = cal.openCurl * 0.85;
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
  return Math.min(1, Math.max(0, (avg - cal.openCurl * 0.5) / (cal.openCurl * 0.5)));
}

export function calibrate(samples: HandGeometry[]): Calibration {
  const vals = samples.map(g => [8, 12, 16, 20].reduce((s, t) => s + g.curl(t), 0) / 4);
  return { openCurl: vals.reduce((a, b) => a + b, 0) / vals.length };
}
```

**Калибровка в UI:** кнопка «Раскройте ладонь», 2 секунды сбор кадров (`samples`), затем `calibrate()`. Это и есть кадр «калибровка» из демо-сценария.

**Промпт для Codex (Модуль 2):**

> Есть класс `HandGeometry` (приложи файл) и типы из `types.ts` (приложи). Напиши `validator.ts` с функциями `readPinch(g)`, `readGrip(g, cal)`, `gripOpenness(g, cal)`, `calibrate(samples)` строго с сигнатурами из моего кода. Пинцет: ошибка WRONG_FINGER, если кончик большого (4) ближе 0.28 к кончикам 12/16/20, а к 8 дальше 0.28. Эспандер: ошибка PINKY_INCOMPLETE, если 8, 12, 16 сжаты (curl < 0.5×openCurl), а 20 нет. Никаких побочных эффектов, только чистые функции. Тесты на фикстурах.

---

## 6. Модуль 3 — `fsm.ts` и `draw.ts`

### 6.1 State machine (чистая функция)

```ts
import { FsmState, Reading } from "./types";

const STABLE_FRAMES = 4; // ~130 мс при 30 fps

export const initialFsm: FsmState = { phase: "WAIT_OPEN", reps: 0, stable: 0 };

export function step(s: FsmState, r: Reading): FsmState {
  if (r.error) return { ...s, stable: 0 };  // ошибочный кадр ничего не засчитывает

  switch (s.phase) {
    case "WAIT_OPEN": {
      const stable = r.open ? s.stable + 1 : 0;
      return stable >= STABLE_FRAMES ? { ...s, phase: "ARMED", stable: 0 } : { ...s, stable };
    }
    case "ARMED": {
      const stable = r.closed ? s.stable + 1 : 0;
      return stable >= STABLE_FRAMES
        ? { phase: "CONFIRMED", reps: s.reps + 1, stable: 0 }
        : { ...s, stable };
    }
    case "CONFIRMED": {
      // повторный балл только после нового раскрытия
      const stable = r.open ? s.stable + 1 : 0;
      return stable >= STABLE_FRAMES ? { ...s, phase: "ARMED", stable: 0 } : { ...s, stable };
    }
  }
}
```

Свойство, которое проверяем тестом: 100 кадров подряд `closed: true` в фазе CONFIRMED дают `reps` без изменений.

### 6.2 Упражнение 3 — удержание (перенос в цель)

```ts
export type HoldState = { holdMs: number; reps: number };
export const HOLD_TARGET_MS = 2000;

export function stepHold(
  s: HoldState, palm: {x:number;y:number}, target: {x:number;y:number;r:number}, dtMs: number
): HoldState {
  const inside = Math.hypot(palm.x - target.x, palm.y - target.y) < target.r;
  if (!inside) return { ...s, holdMs: 0 };            // выход из цели обнуляет прогресс
  const holdMs = s.holdMs + dtMs;
  return holdMs >= HOLD_TARGET_MS ? { holdMs: 0, reps: s.reps + 1 } : { ...s, holdMs };
}
```

После +1 переставьте цель в новую случайную позицию. Координаты ладони и цели должны быть в одной системе (см. п. 6.4 про зеркало).

### 6.3 Отрисовка `drawSmartHand`

```ts
import { HandLandmarker } from "@mediapipe/tasks-vision";
import { Point } from "./types";

export function drawSmartHand(
  ctx: CanvasRenderingContext2D,
  pts: Point[],                 // уже в координатах canvas (с зеркалом)
  success: boolean,
  errorJoints: number[],
) {
  const color = success ? "#22c55e" : "#38bdf8";
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  for (const { start, end } of HandLandmarker.HAND_CONNECTIONS) {
    ctx.beginPath();
    ctx.moveTo(pts[start].x, pts[start].y);
    ctx.lineTo(pts[end].x, pts[end].y);
    ctx.stroke();
  }
  ctx.fillStyle = color;
  pts.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill(); });

  // ошибочный сустав: рука остаётся голубой, точка красная
  ctx.fillStyle = "#ef4444";
  for (const j of errorJoints) {
    ctx.beginPath(); ctx.arc(pts[j].x, pts[j].y, 11, 0, Math.PI * 2); ctx.fill();
  }
}
```

`success` держите `true` 400 мс после каждого нового балла (таймер в `main.ts`).

### 6.4 Зеркало

Видео зеркалим CSS: `video { transform: scaleX(-1) }`. Геометрию считаем на исходных точках, а для отрисовки и цели переводим: `x' = w - x`. Не зеркалить один из слоёв — самая частая причина «рука двигается в обратную сторону».

**Промпт для Codex (Модуль 3):**

> Приложи `types.ts`. Напиши `fsm.ts`: чистая функция `step(state: FsmState, r: Reading): FsmState` с фазами WAIT_OPEN → ARMED → CONFIRMED, подтверждением 4 кадров подряд, без побочных эффектов; удержание закрытого хвата не даёт новых баллов; кадр с `r.error` сбрасывает `stable` и ничего не засчитывает. Отдельно `stepHold` для удержания в круге 2000 мс со сбросом при выходе. Затем `draw.ts` с `drawSmartHand(ctx, pts, success, errorJoints)`: толстые голубые линии, зелёные при `success`, красная точка на суставах из `errorJoints`, рука остаётся голубой. Тесты vitest на `step`.

---

## 7. Камера и цикл (`camera.ts` / `main.ts`)

```ts
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

export async function initTracker() {
  const vision = await FilesetResolver.forVisionTasks("/wasm");
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: "/models/hand_landmarker.task", delegate: "GPU" },
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });
}

export async function initCamera(video: HTMLVideoElement) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480, facingMode: "user" }, audio: false,
  });
  video.srcObject = stream;
  await video.play();
}
```

Цикл:

```ts
let lastT = -1;
function loop() {
  if (video.currentTime !== lastT) {
    lastT = video.currentTime;
    const res = tracker.detectForVideo(video, performance.now());
    const lm = res.landmarks[0];
    if (lm) {
      const g = new HandGeometry(lm, video.videoWidth, video.videoHeight);
      const reading = mode === "pinch" ? readPinch(g) : readGrip(g, cal);
      fsm = step(fsm, reading);
      // draw, hint, session.recordError(...) по переходу null → error
    } else { /* «Рука не видна» */ }
  }
  requestAnimationFrame(loop);
}
```

Разрешение 640×480 достаточно и даёт стабильные 30 fps на слабом ноутбуке. Ошибки в сессии считаем **по переходу** «нет ошибки → ошибка», а не по кадрам.

---

## 8. Сессия и экран результатов (`session.ts`)

```ts
export type Session = {
  startedAt: number;
  exercises: Record<"pinch" | "grip" | "hold", {
    reps: number;
    errors: Partial<Record<"WRONG_FINGER" | "PINKY_INCOMPLETE", number>>;
  }>;
};
```

Экран результатов строится **только** из этого объекта. Формат строки:
«Пинцет: 8 повторов. Ошибочный палец — 3 раза. Эспандер: 6 повторов. Мизинец не дожат — 2 раза. Перенос: 4 цели».

Запрещено на экране и в README: диагнозы, «% восстановления», «лечит», «улучшает состояние». Внизу одна строка: «Тренажёр не является медицинским устройством».

Приватность фиксируется в коде и README: видеопоток не пишется, не отправляется, `fetch` к серверу в приложении отсутствует.

---

## 9. Раздел работы вдвоём и расписание

### Разделение

| Человек | Зона |
|---|---|
| **A** | `geometry.ts`, `validator.ts`, тесты на фикстурах, калибровка |
| **B** | `camera.ts`, `fsm.ts`, `draw.ts`, `main.ts`, экраны, `session.ts` |
| Вместе | `types.ts`, интеграция, тест на двух руках, запись демо |

### Расписание (T = дедлайн, 15:00 30.09)

| Когда | Что | Критерий готово |
|---|---|---|
| T-22 → T-21.5 | Вместе: репозиторий, стек, `types.ts` | Оба ветки, `npm run dev` открывается |
| T-21.5 → T-17 | A: модули 1–2. B: камера, MediaPipe, отрисовка скелета | B видит голубой скелет на своей руке; A проходит тесты |
| T-17 → T-14 | Интеграция: пинцет с FSM, счётчик растёт от одного правильного пинцета | 1 захват = +1, удержание не даёт баллов |
| T-14 → T-11 | Валидатор ошибок поверх пинцета, красный сустав, подсказка | Средний палец → красная точка + текст |
| T-11 → T-9 | Эспандер + шар, «Дожмите мизинец» | Шар меняет размер, ошибка мизинца ловится |
| T-9 → T-7 | Упражнение 3, экран результатов, калибровка | Выход из цели обнуляет прогресс |
| T-7 → T-6 | **Тест на второй руке** (человек с другим размером кисти) | Пороги срабатывают на обеих руках |
| T-6 | **Заморозка функций.** Дальше только баги | Новых фич нет |
| T-6 → T-4 | Сон/перерыв, деплой на Vercel, README | Ссылка открывается с телефона и второго ноутбука |
| T-4 → T-2 | Запись демо (OBS), 2–3 дубля | Файл ≤ 120 с, сценарий из раздела 11 |
| T-2 → T-1 | Проверка формы сдачи, ссылки, доступ к репозиторию | Всё открывается из режима инкогнито |
| T-1 → T | Буфер. Отправить, не ждать последних минут | Отправлено |

Если сейчас позже, чем T-22, сжимайте блоки пропорционально и включайте список из раздела 10.

---

## 10. Список «что режем, если опаздываем»

Режем **сверху вниз**:

| Порядок | Что убрать | Что остаётся |
|---|---|---|
| 1 | Тест на двух рукaх → один человек, но с калибровкой | Калибровка в UI |
| 2 | Упражнение 3 (перенос) | Пинцет + эспандер + ошибка |
| 3 | Ошибка эспандера | Ошибка пинцета (обязательна по сценарию демо) |
| 4 | Шар в упражнении 2 → просто счётчик | Логика FSM |

Не режется никогда: реальная камера, одна ошибка с подсказкой и красным суставом, экран итогов, README, демо-видео. Это то, что видит жюри.

---

## 11. Демо-видео (90–120 с, отдельный скринкаст в OBS)

| Время | Что показать | Проверка |
|---|---|---|
| 0–15 с | Заставка: «Камера распознаёт движения, сохраняет сессию, даёт точные подсказки» | Без медицинских обещаний |
| 15–45 с | Калибровка → пинцет. **Намеренно** сомкнуть большой со средним → красная точка + «Ошибочный палец. Используйте указательный» → исправить → голубой скелет становится зелёным, +1 | Ошибка видна в кадре |
| 45–80 с | Эспандер: шар растёт/сжимается, «Дожмите мизинец». Перенос: ладонь в цель, выход из цели обнуляет полоску | Обнуление читаемо |
| 80–105 с | Экран итогов, цифры совпадают с тем, что делали | Цифры = реальная сессия |
| 105–120 с | README: команды запуска | Видно `npm i && npm run dev` |

Перед записью: свет спереди, не со спины; однотонный фон; закрыть уведомления; рука в кадре целиком. Записать 3 дубля, брать лучший.

---

## 12. Верификация, что обе части работают вместе

1. **Debug-оверлей** (`debug.ts`, клавиша `D`): в углу живые числа `nd(4,8)`, `nd(4,12)`, `curl` четырёх пальцев, фаза FSM, `reps`. Все пороги подбираются по этим цифрам, а не «на глаз».
2. **Кнопка Dump:** сохраняет текущие 21 landmark в JSON. Снимите 5 кадров: открытая ладонь, правильный пинцет, пинцет средним, сжатый кулак, кулак с торчащим мизинцем. Положите в `tests/fixtures/`. Тесты A и B гоняются на этих файлах без камеры.
3. **Контрольные ожидания:**

| Фикстура | `readPinch` | `readGrip` |
|---|---|---|
| открытая ладонь | open | open |
| пинцет указательным | closed | — |
| пинцет средним | error WRONG_FINGER | — |
| кулак | — | closed |
| кулак с мизинцем | — | error PINKY_INCOMPLETE |

4. **Тест «удержания»:** держите закрытый хват 5 секунд, `reps` должен вырасти ровно на 1.

---

## 13. Типовые поломки

| Симптом | Причина | Исправление |
|---|---|---|
| Камера не запрашивается | Не HTTPS / не localhost | Открывать через `localhost` или деплой |
| Рука двигается зеркально | Зеркало применено к одному слою | Раздел 6.4 |
| Счётчик мигает | Нет подтверждения кадров | `STABLE_FRAMES ≥ 4` |
| Ложная ошибка пинцета | Порог 0.28 слишком широкий для вашей руки | Сузить до 0.22–0.25 по debug-цифрам |
| Кулак не считается закрытым | Ладонь повернута к камере ребром | Ладонью к камере, калибровка заново |
| Модель не грузится | Неверный путь к `.task` / wasm | Проверить `public/models`, `public/wasm` |
| Падает fps | Разрешение выше 640×480 | Вернуть 640×480, `delegate: "GPU"` |

---

## 14. README (шаблон)

```md
# NeuroHand
Браузерный тренажёр моторики кисти на веб-камере. Три упражнения: пинцет, эспандер, перенос.
Приложение подсказывает, какой сустав/палец сработал неверно.

## Запуск
npm i
npm run dev   # открыть http://localhost:5173, разрешить камеру

## Приватность
Кадры обрабатываются локально в браузере. Видео не записывается и не отправляется.

## Ограничения
Не медицинское устройство. Диагнозов и оценки восстановления нет.

## Стек
Vite, TypeScript, MediaPipe HandLandmarker, Canvas.

## Тесты
npm test  # фикстуры landmarks в tests/fixtures
Проверено на: <устройство 1>, <устройство 2>
```

---

## 15. Чек-лист сдачи

- [ ] Репозиторий/деплой открывается без входа в аккаунт
- [ ] Демо-видео 90–120 с, ошибка и её исправление видны
- [ ] README с командами запуска
- [ ] На экране итогов нет медицинских обещаний
- [ ] Нигде в коде нет отправки видео/кадров на сервер
- [ ] Ссылка и видео проверены в инкогнито
- [ ] Форма отправлена минимум за час до 15:00

---

**Вывод:** проект реализуем, если заморозить функции за 6 часов до дедлайна, начать с общего `types.ts` и снимать пороги по debug-цифрам на двух руках. Ошибка с красным суставом и подсказкой — главный элемент защиты, его не режем ни при каких условиях.

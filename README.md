# NeuroHand

В репозитории находятся базовый проект Vite и автономные модули для работы
с 21 точкой MediaPipe Hands. План основного приложения описан в
[docs/GUIDE.md](docs/GUIDE.md), порядок разработки — в [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Локальный пример отрисовки

Для автономного примера нужен **Node.js 24 или новее**. Установка зависимостей не требуется.

```bash
node demo-server.mjs
```

Откройте <http://127.0.0.1:52732/>. Сервер слушает только локальный интерфейс.
Остановить его можно сочетанием `Ctrl+C` в терминале запуска.

Пример показывает три состояния на синтетических точках:

- `DEFAULT`: голубые кости и суставы;
- `SUCCESS`: зелёные кости и суставы;
- `ERROR`: голубая рука с красными суставами мизинца `17, 18, 19, 20`.

В этом примере камера не используется, статусы заданы явно. Модули пока не подключены
к циклу кадров основного приложения Vite.

## Модули

| Файл | Назначение |
| --- | --- |
| `HandGeometry.ts` | Расстояния между точками, эвристика сгибания пальцев и доля сжатия кулака |
| `ExerciseValidator.ts` | Проверка щипка и кулака с текстовыми подсказками |
| `drawSmartHand.ts` | Отрисовка костей и суставов через Canvas API |
| `ExerciseValidator.checks.mjs` | Проверки через встроенный тестовый раннер Node.js |
| `demo.html`, `demo-server.mjs` | Автономный локальный пример отрисовки |

```ts
import { HandGeometry } from "./HandGeometry.ts";
import { ExerciseValidator } from "./ExerciseValidator.ts";
import { drawSmartHand } from "./drawSmartHand.ts";

// landmarks — 21 normalized landmark одного кадра MediaPipe Hands.
const aspectRatio = videoWidth / videoHeight;
const geometry = new HandGeometry(landmarks, { aspectRatio });
console.log(geometry.getFistCompletion());

const validator = new ExerciseValidator({ pinchThreshold: 0.05, aspectRatio });
const result = validator.validateFist(landmarks);
const status = result.status === "SUCCESS" ? "SUCCESS" : "ERROR";
const errorJoints = result.status === "ERROR_INCOMPLETE_FIST"
  ? result.extendedFingers
  : [];

ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
drawSmartHand(ctx, landmarks, status, errorJoints);
```

`validatePinch()` возвращает `SUCCESS`, `ERROR_WRONG_FINGER` или `IN_PROGRESS`.
Ошибочный щипок содержит `fingerIndex` и подсказку с названием пальца.
Для отрисовки `IN_PROGRESS` следует переводить в `DEFAULT`.

`validateFist()` проверяет четыре пальца без большого. При неполном сжатии
возвращает `ERROR_INCOMPLETE_FIST`, подсказку (например, «Дожмите мизинец»)
и индексы кончиков несжатых пальцев. Чтобы выделить весь мизинец, передайте
в `drawSmartHand()` массив `[17, 18, 19, 20]`.

## Проверки

```bash
node --test ExerciseValidator.checks.mjs
```

Проверяются правильный щипок, каждый ошибочный палец, граница порога,
выбор ближайшего пальца, соотношение сторон кадра, все 16 комбинаций сгибания
четырёх пальцев и некорректные входные данные. Имя `.checks.mjs` отделяет эти
проверки Node.js от тестов Vitest основного проекта.

## Основной проект Vite

```bash
npm ci
npm run dev
npm run build
```

## Особенности геометрии

- `HandGeometry.getFistCompletion()` учитывает все пять пальцев и возвращает
  долю согнутых пальцев с шагом 20%. Это не оценка силы сжатия.
- Пороги эвристические и требуют настройки на реальных кадрах. Порог щипка
  задан в единицах координат, а не нормирован на размер ладони.
- Для normalized landmarks указывайте `aspectRatio = ширина / высота`.
  Для world landmarks используйте `aspectRatio: 1` и порог в метрах.
- `drawSmartHand()` принимает normalized landmarks, использует размеры
  буфера canvas и временно сбрасывает трансформацию контекста. Очистку
  кадра и зеркалирование выполняет вызывающий код.
- Автономные модули имеют свой API и ещё не адаптированы к контракту `Reading`
  из `src/types.ts`.

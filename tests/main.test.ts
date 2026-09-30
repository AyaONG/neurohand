import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Landmark } from "../src/types";

const mocks = vi.hoisted(() => ({
  camera: vi.fn(), tracker: vi.fn(), detect: vi.fn(), close: vi.fn(), stop: vi.fn(), draw: vi.fn(), dump: vi.fn(),
}));
const authMock = vi.hoisted(() => {
  const state = { listener: (_event: string, _session: unknown) => {}, initialId: null as string | null };
  const auth = { onAuthStateChange: vi.fn(callback => { state.listener = callback; return { data: { subscription: { unsubscribe() {} } } }; }),
    getSession: vi.fn(async () => ({ data: { session: state.initialId ? { user: { id: state.initialId } } : null }, error: null })),
    signOut: vi.fn(async () => { state.listener('SIGNED_OUT', null); return { error: null }; }), signInWithOAuth: vi.fn(async () => ({ error: null })) };
  return { state, auth };
});
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: authMock.auth }) }));
const syncMock = vi.hoisted(() => ({ rows: [] as any[] }));
vi.mock('../src/sync', async importOriginal => {
  const original = await importOriginal<typeof import('../src/sync')>();
  return { ...original, supabaseTransport: () => ({
    insert: vi.fn(async (owner, payload) => {
      const row = { user_id: owner, id: payload.id, schema_version: 3, started_at: payload.startedAt, ended_at: payload.endedAt, status: payload.status, payload };
      syncMock.rows.push(row); return row;
    }), get: vi.fn(async (owner,id) => syncMock.rows.find(r => r.user_id === owner && r.id === id) ?? null),
    page: vi.fn(async owner => syncMock.rows.filter(r => r.user_id === owner).slice(0,30)),
  }) };
});
vi.mock("../src/camera", () => ({
  initCamera: async () => { await mocks.camera(); return { getTracks: () => [{ stop: mocks.stop, addEventListener: vi.fn() }] }; },
  initTracker: async () => { mocks.tracker(); return { detectForVideo: mocks.detect, close: mocks.close }; },
}));
vi.mock("../src/draw", () => ({
  drawHandOverlay: mocks.draw,
  mirrorPoint: (p: { x: number; y: number }, width: number) => ({ x: width - p.x, y: p.y }),
}));
vi.mock("../src/debug", () => ({ updateDebug: vi.fn(), dumpCapture: mocks.dump }));

// Minimal DOM adapter: tests the real app event handlers and session/FSM wiring.
// This is simulated input, not a browser/camera check. Storage is isolated in memory.
class Element {
  id = "";
  hidden = false;
  disabled = false;
  textContent = "";
  tabIndex = 0;
  className = "";
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: Element[] = [];
  attrs: Record<string, string> = {};
  classes = new Set<string>();
  handlers: Record<string, ((event: unknown) => unknown)[]> = {};
  classList = { toggle: (name: string, enabled: boolean) => enabled ? this.classes.add(name) : this.classes.delete(name) };
  addEventListener(name: string, callback: (event: unknown) => unknown) { (this.handlers[name] ??= []).push(callback); }
  async fire(name: string, event = { target: this } as unknown) {
    await Promise.all((this.handlers[name] ?? []).map(callback => callback(event)));
  }
  setAttribute(name: string, value: string) { this.attrs[name] = value; }
  removeAttribute(name: string) { delete this.attrs[name]; }
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: Element[]) { this.children = items; }
  focus() {}
  closest() { return this; }
  querySelectorAll() { return this.children.filter(child => !!child.dataset.mode); }
  querySelector(selector: string): Element | undefined {
    if (selector.startsWith('#')) return this.children.find(child => child.id === selector.slice(1)) ?? this.children.map(child => child.querySelector(selector)).find(Boolean);
    return this.children.find(child => selector.includes(`"${child.dataset.mode}"`));
  }
}

const fixture = (name: string): Landmark[] => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
let elements: Record<string, Element>;
let modes: Record<string, Element>;
let video: Element & { videoWidth: number; videoHeight: number; readyState: number; currentTime: number };
let nextFrame: FrameRequestCallback | null;
let time: number;

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
}
async function setup(search = "", storage = memoryStorage()) {
  elements = Object.fromEntries(["automatic-flow", "route-guided", "route-opposition", "route-ring", "success-star", "pair-8-12", "pair-8-16", "pair-8-20", "pair-12-16", "pair-12-20", "pair-16-20", "card-pairs", "card-ring", "option-pairs", "option-ring", "sync-panel", "sync-status", "btn-sync-retry", "btn-cloud-more", "btn-import-guest", "guest-import", "btn-export-json", "import-json", "transfer-status", "auth-status", "btn-sign-in", "btn-sign-out", "video", "canvas", "stage", "viewport", "task-title", "task-description", "hint", "score", "debug", "btn-start", "btn-calibrate", "btn-dump", "tabs", "panel", "results", "btn-results", "btn-pause", "hand-choice", "program-status", "history", "btn-history", "storage-notice", "home", "announcements", "camera-placeholder", "hand-label", "ring-options", "ring-tip", "btn-choose-ring", "training-choice", "pair-options", "pair-8", "pair-12", "pair-16", "pair-20", "pair-guide", "btn-finish-attempt", "btn-skip-pair", "btn-choose-pairs", "guide-tip-4", "guide-tip-8", "guide-tip-12", "guide-tip-16", "guide-tip-20"]
    .map(id => [id, Object.assign(new Element(), { id })]));
  elements.results.hidden = true;
  Object.assign(elements['training-choice'], { value: 'guided' });
  modes = Object.fromEntries(["pinch", "grip", "hold"].map(mode => [mode, Object.assign(new Element(), { dataset: { mode } })]));
  elements.tabs.children = Object.values(modes);
  video = Object.assign(elements.video, { videoWidth: 640, videoHeight: 480, readyState: 2, currentTime: 0 });
  Object.assign(elements.canvas, { width: 640, height: 480, getContext: () => ({ clearRect: vi.fn() }) });
  const document = Object.assign(new Element(), {
    querySelector: (selector: string) => elements[selector.slice(1)], createElement: () => new Element(),
  });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", Object.assign(new Element(), { localStorage: storage }));
  vi.stubGlobal("location", { search, href: `http://localhost:5173/${search}`, origin: "http://localhost:5173" });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => { nextFrame = null; });
  await import("../src/main");
}

function frame(lm: Landmark[] | null, dt = 33) {
  time += dt;
  video.currentTime = time / 1000;
  mocks.detect.mockReturnValue({ landmarks: lm ? [lm] : [] });
  const callback = nextFrame;
  nextFrame = null;
  callback?.(time);
}

function prepare() { for (let i = 0; i < 100; i++) frame(fixture("grip_open")); }

function pinch() {
  if (elements.hint.textContent.includes("Далее") || (elements.hint.textContent.includes("засчитан") || elements.hint.textContent === "Выполнено")) for (let i=0; i<135; i++) frame(fixture("grip_open"));
  for (let i = 0; i < 6; i++) frame(fixture("pinch_open"));
  for (let i = 0; i < 6; i++) frame(fixture("pinch_closed"));
}

beforeEach(() => { vi.stubEnv("VITE_SUPABASE_URL", ""); vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", ""); vi.resetModules(); vi.clearAllMocks(); syncMock.rows = []; nextFrame = null; time = 1000; });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); authMock.state.initialId = null; });

describe("app wiring with simulated camera frames", () => {
  it("opens useful empty results before camera startup, then returns", async () => {
    await setup();
    await elements["btn-results"].fire("click");
    expect(elements.results.hidden).toBe(false);
    expect(elements.stage.hidden).toBe(true);
    expect(elements.results.children[1].textContent).toContain("Движений пока нет");
    expect(elements.results.children[2].children.map(row => row.textContent)).toEqual([
      "Пинцет: Не начато", "Сжатия: Не начато", "Перенос: Не начато",
    ]);
    await elements.results.children.find(child => child.id === "btn-resume")!.fire("click");
    expect(elements.results.hidden).toBe(true);
    expect(elements.home.hidden).toBe(false);
    expect(elements.stage.hidden).toBe(true);
    expect(nextFrame).toBeNull();
  });

  it("counts three pinches once, celebrates, freezes results, and requires reopening after resume", async () => {
    await setup();
    await elements["btn-start"].fire("click");
    prepare();
    for (let rep = 1; rep <= 3; rep++) {
      pinch();
      expect(elements.score.textContent).toBe(`Пинцет: ${rep} / 5`);
      expect(elements.hint.textContent).toBe("Выполнено");
      expect(elements["success-star"].hidden).toBe(false);
      expect(mocks.draw.mock.lastCall?.[3].success).toBe(true);
      const scene = mocks.draw.mock.lastCall![3].scene;
      expect(scene.completed).toBe(rep);
      expect(scene.flight).toBeNull();
      const at = elements["success-star"].dataset.event;
      frame(fixture("pinch_closed"));
      expect(elements["success-star"].dataset.event).toBe(at);
    }
    for (let i = 0; i < 160; i++) frame(fixture("pinch_closed"));
    expect(elements.score.textContent).toBe("Пинцет: 3 / 5");
    expect(elements.hint.textContent).toContain("Раскрой ладонь");
    expect(mocks.draw.mock.lastCall?.[3].success).toBe(false);
    await elements["btn-results"].fire("click");
    const snapshot = elements.results.children[2].children.map(row => row.textContent);
    expect(snapshot).toEqual(["Пинцет: 3 / 5", "Сжатия: Не начато", "Перенос: Не начато"]);
    const calls = mocks.detect.mock.calls.length;
    pinch();
    expect(mocks.detect.mock.calls.length).toBe(calls);
    expect(elements.results.children[2].children.map(row => row.textContent)).toEqual(snapshot);
    await elements["btn-results"].fire("click");
    for (let i = 0; i < 20; i++) frame(fixture("pinch_closed"));
    expect(elements.score.textContent).toBe("Пинцет: 3 / 5");
    prepare();
    pinch();
    expect(elements.score.textContent).toBe("Пинцет: 4 / 5");
    await elements.tabs.fire("click", { target: modes.grip });
    expect(elements.score.textContent).toBe("Пинцет: 4 / 5");
    await elements.tabs.fire("click", { target: modes.pinch });
    expect(elements.score.textContent).toBe("Пинцет: 4 / 5");
  });

  it("keeps both debug surfaces and Dump off by default, and enables them explicitly", async () => {
    await setup();
    expect(elements.debug.hidden).toBe(true);
    expect(elements["btn-dump"].hidden).toBe(true);
    await elements["btn-start"].fire("click");
    prepare();
    frame(fixture("pinch_open"));
    expect(mocks.draw.mock.lastCall?.[3].enabled).toBe(false);
    await elements["btn-dump"].fire("click");
    expect(mocks.dump).not.toHaveBeenCalled();
    await (document as unknown as Element).fire("keydown", { code: "KeyD" });
    frame(fixture("pinch_open"));
    expect(elements.debug.hidden).toBe(false);
    expect(elements["btn-dump"].hidden).toBe(false);
    expect(mocks.draw.mock.lastCall?.[3].enabled).toBe(true);
    await elements["btn-dump"].fire("click");
    expect(mocks.dump).toHaveBeenCalledOnce();
    expect(mocks.dump.mock.lastCall![0]).toMatchObject({ videoWidth: 640, videoHeight: 480, exercise: "pinch" });
    expect(mocks.dump.mock.lastCall![0]).toHaveProperty("observedReading");
    expect(mocks.dump.mock.lastCall![0]).not.toHaveProperty("expectedReading");
  });

  it("runs the full guided route without tabs, finalizes once, stops tracks and starts a separate training", async () => {
    const memory = memoryStorage();
    await setup('', memory);
    await elements["btn-start"].fire("click");
    await elements["btn-start"].fire("click");
    expect(mocks.camera).toHaveBeenCalledOnce();
    expect(mocks.tracker).toHaveBeenCalledOnce();
    prepare();
    for (let rep = 0; rep < 5; rep++) pinch();
    expect(elements.score.textContent).toBe("Пинцет: 5 / 5");
    for (let i = 0; i < 135; i++) frame(fixture("grip_open"));
    expect(elements.score.textContent).toBe("Эспандер: 0 / 5");
    for (let rep = 0; rep < 5; rep++) {
      if (rep) for (let i=0; i<135; i++) frame(fixture("grip_open"));
      for (let i = 0; i < 6; i++) frame(fixture("grip_open"));
      for (let i = 0; i < 6; i++) frame(fixture("grip_closed"));
    }
    for (let i = 0; i < 135; i++) frame(fixture("grip_open"));
    expect(elements.score.textContent).toBe("Перенос: 0 / 3");
    for (let goal = 0; goal < 3; goal++) {
      const target = mocks.draw.mock.lastCall![3].target;
      const lm = fixture("grip_open").map(p => ({
        x: p.x + (640 - target.x - 212) / 640,
        y: p.y + (target.y - 228) / 480, z: p.z,
      }));
      for (let i = 0; i < 65; i++) frame(lm);
      if (goal < 2) {
        for (let i = 0; i < 160; i++) frame(lm); // Stay at the completed target for >5 seconds.
        expect(elements.score.textContent).toBe(`Перенос: ${goal + 1} / 3`);
        expect(mocks.draw.mock.lastCall![3].scene.holdProgress).toBe(0);
        expect(mocks.draw.mock.lastCall![3].target.x).not.toBe(target.x);
      }
    }
    for (let i=0; i<100; i++) frame(fixture("grip_open"));
    expect(elements.results.hidden).toBe(false);
    expect(elements.results.children[0].textContent).toBe("Тренировка завершена");
    const snapshot = elements.results.children[2].children.map(row => row.textContent);
    expect(snapshot).toEqual(["Пинцет: 5 / 5", "Сжатия: 5 / 5", "Перенос: 3 / 3"]);
    const attempts = JSON.parse(memory.getItem('neurohand:progress:v3')!).history[0].attempts.records;
    expect(attempts).toHaveLength(13);
    expect(attempts.every((a: { outcome: string }) => a.outcome === 'completed')).toBe(true);
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(nextFrame).toBeNull();
    await elements["btn-results"].fire("click");
    expect(elements.results.children[2].children.map(row => row.textContent)).toEqual(snapshot);
    await elements.results.children.find(child => child.id === "btn-new")!.fire("click");
    expect(elements.score.textContent).toBe("Пинцет: 0 / 5");
    await elements["btn-start"].fire("click");
    expect(mocks.camera).toHaveBeenCalledTimes(2);
    expect(mocks.tracker).toHaveBeenCalledTimes(2);
    expect(elements.score.textContent).toBe("Пинцет: 0 / 5");
  });

  it("stops early with a distinct result and pauses on a hidden tab without adding its time", async () => {
    await setup(); await elements["btn-start"].fire("click"); prepare(); pinch();
    (document as unknown as Element).hidden = true;
    await (document as unknown as Element).fire("visibilitychange");
    expect(nextFrame).toBeNull();
    frame(fixture("pinch_closed"), 10000);
    expect(elements.score.textContent).toBe("Пинцет: 1 / 5");
    await elements["btn-results"].fire("click");
    await elements.results.children.find(child => child.id === "btn-finish")!.fire("click");
    expect(elements.results.children[0].textContent).toBe("Тренировка остановлена");
    expect(elements.results.children[2].children[0].textContent).toBe("Пинцет: 1 / 5");
  });

  it("cancels an unfinished camera startup without starting a second tracker", async () => {
    await setup();
    let release!: () => void;
    mocks.camera.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const pendingStart = elements["btn-start"].fire("click");
    await elements["btn-start"].fire("click");
    expect(mocks.camera).toHaveBeenCalledOnce();
    await elements["btn-results"].fire("click");
    await elements.results.children.find(child => child.id === "btn-finish")!.fire("click");
    await elements.results.children.find(child => child.id === "btn-new")!.fire("click");
    expect(elements["btn-start"].disabled).toBe(true);
    await elements["btn-start"].fire("click");
    expect(mocks.camera).toHaveBeenCalledOnce();
    release(); await pendingStart;
    expect(mocks.tracker).not.toHaveBeenCalled();
    expect(nextFrame).toBeNull();
    await elements["btn-start"].fire("click");
    expect(mocks.camera).toHaveBeenCalledTimes(2);
    expect(mocks.tracker).toHaveBeenCalledOnce();
  });

  it("supports the debug query flag without making it a persisted preference", async () => {
    await setup("?debug=1");
    expect(elements.debug.hidden).toBe(false);
    expect(elements["btn-dump"].hidden).toBe(false);
  });
});


describe("persistent progress through real handlers with isolated storage", () => {
  it("restores a paused snapshot after reload, resumes without duplicate actions and archives once", async () => {
    const memory = memoryStorage();
    await setup("", memory);
    Object.assign(elements["hand-choice"], { value: "left" });
    await elements["btn-start"].fire("click");
    prepare(); pinch();
    await elements["btn-results"].fire("click");
    const before = JSON.parse(memory.getItem("neurohand:progress:v3")!).current;
    expect(before.exercises.pinch.reps).toBe(1);
    // Reload modules and DOM, retaining only this test's isolated storage.
    vi.resetModules(); nextFrame = null;
    await setup("", memory);
    expect(nextFrame).toBeNull();
    expect(elements.results.hidden).toBe(false);
    expect(elements.results.children.at(-1)?.textContent).toContain("прервана перезагрузкой");
    expect(JSON.parse(memory.getItem("neurohand:progress:v3")!).current.exercises.pinch.activeMs).toBe(before.exercises.pinch.activeMs);
    await elements.results.children.find(child => child.id === "btn-resume")!.fire("click");
    await elements["btn-start"].fire("click");
    for (let i = 0; i < 150; i++) frame(fixture("pinch_closed"));
    expect(elements.score.textContent).toBe("Пинцет: 1 / 5");
    prepare(); pinch();
    expect(elements.score.textContent).toBe("Пинцет: 2 / 5");
    await elements["btn-results"].fire("click");
    await elements.results.children.find(child => child.id === "btn-finish")!.fire("click");
    await elements["btn-results"].fire("click");
    const saved = JSON.parse(memory.getItem("neurohand:progress:v3")!);
    expect(saved.current).toBeNull(); expect(saved.history).toHaveLength(1);
    expect(saved.history[0].status).toBe("stopped"); expect(saved.history[0].id).toBe(before.id);
    expect(saved.history[0].exercises.pinch.reps).toBe(2);
    await elements.results.children.find(child => child.id === "btn-new")!.fire("click");
    await elements["btn-start"].fire("click");
    expect(JSON.parse(memory.getItem("neurohand:progress:v3")!).history).toEqual(saved.history);
  });

  it("pauses for history, displays empty and populated tables, and details never start camera", async () => {
    await setup();
    await elements["btn-history"].fire("click");
    const text = (node: Element): string => node.textContent + node.children.map(text).join(" ");
    expect(elements.history.hidden).toBe(false);
    expect(text(elements.history)).toContain("Завершённых тренировок пока нет");
    expect(mocks.camera).not.toHaveBeenCalled();
    await elements.history.children.find(child => child.id === "btn-history-back")!.fire("click");
    await elements["btn-start"].fire("click"); prepare(); pinch();
    await elements["btn-history"].fire("click");
    expect(nextFrame).toBeNull();
    expect(text(elements.history)).toContain("Текущая тренировка");
    await elements.history.children.find(child => child.id === "btn-history-back")!.fire("click");
    await elements.results.children.find(child => child.id === "btn-finish")!.fire("click");
    await elements["btn-history"].fire("click");
    expect(text(elements.history)).toContain("Последняя тренировка");
    expect(text(elements.history)).toContain("Остановлена");
    expect(text(elements.history)).toContain("1/5");
    const cameras = mocks.camera.mock.calls.length;
    await elements.history.children.find(child => child.textContent.startsWith("Детали:"))!.fire("click");
    expect(mocks.camera.mock.calls.length).toBe(cameras);
    expect(text(elements.history)).toContain("Пинцет: 1 / 5");
  });
});


it("shows storage failure while keeping the training and its history usable in memory", async () => {
  const memory = memoryStorage();
  memory.setItem.mockImplementation(() => { throw new Error("QuotaExceededError"); });
  await setup("", memory);
  await elements["btn-start"].fire("click"); prepare(); pinch();
  expect(elements["storage-notice"].textContent).toContain("история не сохраняется");
  expect(elements.score.textContent).toBe("Пинцет: 1 / 5");
  await elements["btn-results"].fire("click");
  await elements.results.children.find(child => child.id === "btn-finish")!.fire("click");
  await elements["btn-history"].fire("click");
  expect(elements.history.children.some(child => child.textContent === "Последняя тренировка")).toBe(true);
});

it("shows home, preparation and ordered steps, with a separate live-event message", async () => {
  await setup();
  expect(elements.home.hidden).toBe(false);
  expect(elements.stage.hidden).toBe(true);
  expect(elements["btn-pause"].hidden).toBe(true);
  await elements["btn-start"].fire("click");
  expect(elements.home.hidden).toBe(true);
  expect(elements.stage.hidden).toBe(false);
  for (let i = 0; i < 20; i++) frame(fixture("grip_open"));
  expect(elements["task-title"].textContent).toBe("Подготовим ладонь");
  expect(elements.announcements.textContent).toBe("Держи открытую ладонь для подготовки");
  const announcement = elements.announcements.textContent;
  frame(fixture("grip_open"));
  expect(elements.announcements.textContent).toBe(announcement);
  prepare();
  expect(elements["program-status"].textContent).toBe("Цель 1 из 5 · Попытка 1");
  expect(modes.pinch.textContent).toContain("Сейчас");
  expect(modes.grip.textContent).toContain("Далее");
  for (let i = 0; i < 5; i++) pinch();
  expect(modes.pinch.textContent).toContain("Готово");
  await elements["btn-pause"].fire("click");
  expect(elements["btn-pause"].attrs["aria-pressed"]).toBe("true");
  await elements["btn-history"].fire("click");
  expect(elements["btn-history"].attrs["aria-expanded"]).toBe("true");
  expect(elements.hint.hidden).toBe(true);
});

it("explains denied camera access and leaves a visible retry action", async () => {
  mocks.camera.mockRejectedValueOnce(Object.assign(new Error("denied"), { name: "NotAllowedError" }));
  await setup();
  await elements["btn-start"].fire("click");
  expect(elements.hint.textContent).toContain("Доступ к камере запрещён");
  expect(elements["btn-start"].hidden).toBe(false);
  expect(elements["btn-start"].disabled).toBe(false);
  expect(elements["btn-pause"].hidden).toBe(true);
  expect(nextFrame).toBeNull();
});

function pairPose(tip: number, distance = 0.1) {
  const lm = fixture('grip_open');
  lm[4] = { x: lm[tip].x, y: lm[tip].y + distance * 100 / 480, z: 0 };
  return lm;
}

it('selects only the middle pair, highlights it, rejects the index and finishes with a partial result through real handlers', async () => {
  const memory = memoryStorage(); await setup('', memory);
  await elements['btn-choose-pairs'].fire('click');
  expect(elements['pair-options'].hidden).toBe(false);
  Object.assign(elements['pair-12'], { checked: true });
  await elements['btn-start'].fire('click'); prepare();
  const initial = JSON.parse(memory.getItem('neurohand:progress:v3')!).current;
  expect(initial.opposition.allowed).toEqual([12]); expect(initial.opposition.sequence).toEqual([12, 12]);
  expect(elements['task-title'].textContent).toContain('средний');
  expect(elements['guide-tip-4'].classes.has('selected')).toBe(true);
  expect(elements['guide-tip-12'].classes.has('selected')).toBe(true);
  expect(elements['guide-tip-8'].classes.has('selected')).toBe(false);
  expect(elements.tabs.hidden).toBe(true);
  for (let i = 0; i < 30; i++) frame(pairPose(8));
  expect(elements.hint.textContent).toContain('средний'); expect(elements.hint.classes.has('error')).toBe(true);
  expect(elements.score.textContent).toContain('Выполнено: 0');
  for (let i = 0; i < 20; i++) frame(pairPose(12));
  expect(mocks.draw.mock.lastCall![3].pairTip).toBe(12);
  expect(mocks.draw.mock.lastCall![3].scene).toBeUndefined();
  expect(elements.score.textContent).toContain('Выполнено: 1 / 2 · Пропущено: 0 · Попытки: 1 оценённых');
  for (let i = 0; i < 160; i++) frame(pairPose(12));
  expect(elements.score.textContent).toContain('Выполнено: 1 / 2');
  for (let i = 0; i < 30; i++) frame(fixture('grip_open'));
  for (let i = 0; i < 20; i++) frame(pairPose(12, 0.4));
  expect(elements['btn-finish-attempt'].disabled).toBe(false);
  await elements['btn-finish-attempt'].fire('click');
  expect(JSON.parse(memory.getItem('neurohand:progress:v3')!).current.opposition.cursor).toBe(1);
  await elements['btn-results'].fire('click');
  await elements.results.querySelector('#btn-finish')!.fire('click');
  expect(elements.results.children[0].textContent).toBe('Тренировка остановлена');
  expect(elements.results.children[2].children[0].textContent).toContain('1 / 2');
  const final = JSON.parse(memory.getItem('neurohand:progress:v3')!).history[0];
  expect(final.attempts.records.map((a: { outcome: string }) => a.outcome)).toEqual(['completed', 'partial']);
  expect(nextFrame).toBeNull();
  await elements['btn-results'].fire('click');
  expect(JSON.parse(memory.getItem('neurohand:progress:v3')!).history).toHaveLength(1);
  await elements['btn-history'].fire('click');
  const text = (node: Element): string => node.textContent + node.children.map(text).join(' ');
  expect(text(elements.history)).toContain('частично: 1');
});

it('requires at least one pair before opening the camera and allows explicit skips', async () => {
  const memory = memoryStorage(); await setup('', memory);
  await elements['btn-choose-pairs'].fire('click');
  await elements['btn-start'].fire('click');
  expect(elements.hint.textContent).toContain('Выбери хотя бы одну пару');
  expect(mocks.camera).not.toHaveBeenCalled();
  Object.assign(elements['pair-20'], { checked: true });
  await elements['btn-start'].fire('click'); prepare();
  await elements['btn-skip-pair'].fire('click');
  expect(elements.score.textContent).toContain('Выполнено: 0 / 2 · Пропущено: 1 · Попытки: 0 оценённых');
  await elements['btn-skip-pair'].fire('click');
  expect(elements.score.textContent).toContain('Выполнено: 0 / 2 · Пропущено: 1');
  for (let i = 0; i < 120; i++) frame(fixture('grip_open'));
  await elements['btn-skip-pair'].fire('click');
  for (let i=0; i<100; i++) frame(fixture('grip_open'));
  expect(elements.results.children[2].children[0].textContent).toContain('0 / 2');
  expect(JSON.parse(memory.getItem('neurohand:progress:v3')!).history[0].attempts.records.every((a: { outcome: string }) => a.outcome === 'cancelled')).toBe(true);
});

function ringPose(angle: number, tip = 8) {
  const lm = fixture('grip_open');
  lm[tip] = { x: 1 - (320 + 144 * Math.sin(angle)) / 640, y: (240 - 144 * Math.cos(angle)) / 480, z: 0 };
  return lm;
}
it.each([8, 20])('wires selected ring tip %i, partial completion and history through real handlers', async tip => {
  const memory = memoryStorage(); await setup('', memory);
  await elements['btn-choose-ring'].fire('click');
  expect(elements['ring-options'].hidden).toBe(false); expect(elements['pair-options'].hidden).toBe(true);
  Object.assign(elements['ring-tip'], { value: String(tip) });
  await elements['btn-start'].fire('click');
  for (let i = 0; i < 20; i++) frame(ringPose(0, tip));
  expect(elements['btn-finish-attempt'].disabled).toBe(true);
  for (let x = 0.025; x <= 4.05; x += 0.025) frame(ringPose(x, tip));
  expect(mocks.draw.mock.lastCall![3].ring).toEqual({ tip, marks: 8 });
  expect(elements.score.textContent).toContain('8 / 12');
  expect(elements['btn-skip-pair'].hidden).toBe(false);
  await elements['btn-finish-attempt'].fire('click');
  await elements['btn-results'].fire('click');
  await elements.results.querySelector('#btn-finish')!.fire('click');
  expect(elements.results.children[2].children[0].textContent).toContain('8 / 12');
  const s = JSON.parse(memory.getItem('neurohand:progress:v3')!).history[0];
  expect(s.mode).toBe('ring'); expect(s.ring.tip).toBe(tip);
  expect(s.attempts.records[0]).toMatchObject({ outcome: 'partial', metrics: { marks: 8, returned: false } });
  expect(s.exercises.ring.reps).toBe(0); expect(nextFrame).toBeNull();
  await elements['btn-history'].fire('click');
  const text = (node: Element): string => node.textContent + node.children.map(text).join(' ');
  expect(text(elements.history)).toContain('Обведи кольцо: 8 / 12');
});
it('a window resize finalizes a ring segment and cannot resume a paused camera attempt', async () => {
  const memory = memoryStorage(); await setup('', memory);
  await elements['btn-choose-ring'].fire('click'); await elements['btn-start'].fire('click');
  for (let i = 0; i < 20; i++) frame(ringPose(0));
  for (let x = 0.025; x <= 2; x += 0.025) frame(ringPose(x));
  await (window as unknown as Element).fire('resize');
  let s = JSON.parse(memory.getItem('neurohand:progress:v3')!).current;
  expect(s.attempts.records[0]).toMatchObject({ outcome: 'unscorable', endReason: 'resize' });
  expect(s.attempts.active).toBeNull();
  await elements['btn-pause'].fire('click');
  await (window as unknown as Element).fire('resize');
  s = JSON.parse(memory.getItem('neurohand:progress:v3')!).current;
  expect(s.paused).toBe(true); expect(s.attempts.records).toHaveLength(1);
});

it('filters history by exercise, hand and conditions, pages visible rows without deleting storage', async () => {
  const { createSession, createRingSession, finishSession } = await import('../src/session');
  const { settleRing } = await import('../src/ring');
  const memory = memoryStorage();
  const history = Array.from({ length: 35 }, (_, i) => {
    const s = createSession(`basic-${i}`, '2026-09-30T00:00:00Z'); s.hand = 'left';
    return finishSession(s, 'stopped', '2026-09-30T00:01:00Z');
  });
  for (const hand of ['left', 'right'] as const) {
    const s = createRingSession(8, `ring-${hand}`, '2026-09-30T00:00:00Z'); s.hand = hand; delete s.attempts!.runs; // legacy snapshot
    s.attempts!.records.push({ attemptId: hand, exerciseId: 'ring', hand, rulesVersion: 'ring-v1', protocolVersion: s.protocolId,
      recognizerVersion: s.recognitionVersion, settings: { target: 1, maxActiveMs: 15000, targetRadiusRatio: 0.12, holdTargetMs: 2000, ring: s.ring },
      startedAt: s.startedAt, lastObservedAt: s.startedAt, endedAt: s.startedAt, outcome: 'partial', endReason: 'manual',
      activeMs: 5000, validTrackingMs: 5000, interruptions: { count: 0, durationMs: 0 },
      metrics: { kind: 'ring', marks: 8, returned: false, progress: 8 / 12, pathLength: 4 } });
    history.push(settleRing(s));
  }
  const raw = JSON.stringify({ schemaVersion: 3, current: null, history });
  memory.setItem('neurohand:progress:v3', raw);
  await setup('', memory); await elements['btn-history'].fire('click');
  const flatten = (node: Element): Element[] => [node, ...node.children.flatMap(flatten)];
  const find = (id: string) => flatten(elements.history).find(n => n.id === id)!;
  const details = () => flatten(elements.history).filter(n => n.textContent.startsWith('Детали:'));
  expect(details()).toHaveLength(30);
  await find('history-next').fire('click'); expect(details()).toHaveLength(7);
  expect(memory.getItem('neurohand:progress:v3')).toBe(raw);
  Object.assign(find('history-exercise'), { value: 'ring' }); await find('history-exercise').fire('change');
  expect(details()).toHaveLength(2); expect(find('history-previous').disabled).toBe(true);
  Object.assign(find('history-hand'), { value: 'left' }); await find('history-hand').fire('change');
  expect(details()).toHaveLength(1);
  Object.assign(find('history-series'), { value: 'ring-left' }); await find('history-series').fire('change');
  expect(details()).toHaveLength(1);
  const texts = () => flatten(elements.history).map(n => n.textContent).join(' ');
  expect(texts()).toContain('Лучший оценённый путь: 8 / 12');
  expect(texts()).toContain('частично: 1'); expect(texts()).toContain('Статус занятия'); expect(texts()).toContain('Статусы попыток');
  await details()[0].fire('click'); expect(texts()).toContain('Выполнено частично');
  Object.assign(find('history-hand'), { value: 'unspecified' }); await find('history-hand').fire('change');
  expect(details()).toHaveLength(0); expect(texts()).toContain('По выбранным фильтрам занятий нет');
  expect(texts()).toContain('Недостаточно сопоставимых занятий');
  expect(memory.getItem('neurohand:progress:v3')).toBe(raw);
});


it('pauses the old owner, clears private views and restores only the new profile on real auth events', async () => {
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_example');
  const A = '11111111-1111-4111-8111-111111111111', B = '22222222-2222-4222-8222-222222222222';
  authMock.state.initialId = A;
  const memory = memoryStorage(); await setup('', memory);
  await elements['btn-start'].fire('click'); prepare(); pinch();
  await elements['btn-history'].fire('click');
  expect(elements.history.children.length).toBeGreaterThan(0);
  authMock.state.listener('SIGNED_IN', { user: { id: B } });
  expect(elements.history.children).toHaveLength(0); expect(elements.results.children).toHaveLength(0);
  expect(elements.home.hidden).toBe(false); expect(nextFrame).toBeNull();
  const keyA = `neurohand:profile:user:${A}:neurohand:progress:v3`;
  const old = JSON.parse(memory.getItem(keyA)!);
  expect(old.current.paused).toBe(true); expect(old.current.exercises.pinch.reps).toBe(1);
  expect(memory.getItem(`neurohand:profile:user:${B}:neurohand:progress:v3`)).toBeNull();
  authMock.state.listener('TOKEN_REFRESHED', { user: { id: A } });
  expect(elements.results.children).toHaveLength(0);
  authMock.state.listener('SIGNED_IN', { user: { id: A } });
  expect(elements.results.hidden).toBe(false);
  expect(elements.results.children[2].children[0].textContent).toContain('1 / 5');
  await elements['btn-sign-out'].fire('click');
  expect(elements.history.children).toHaveLength(0); expect(elements.results.children).toHaveLength(0);
  expect(elements['auth-status'].textContent).toContain('Прогресс сохраняется в этом браузере');
  expect(JSON.parse(memory.getItem(keyA)!).current.exercises.pinch.reps).toBe(1);
});


it('offers unchecked guest choices and imports only selected finals with truthful server confirmation', async () => {
  const { createSession, finishSession } = await import('../src/session');
  const memory = memoryStorage();
  const history = ['guest-first', 'guest-second'].map(id => finishSession(createSession(id, '2026-09-30T00:00:00Z'), 'stopped', '2026-09-30T00:01:00Z'));
  memory.setItem('neurohand:progress:v3', JSON.stringify({ schemaVersion: 3, current: null, history }));
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co'); vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_example');
  authMock.state.initialId = '11111111-1111-4111-8111-111111111111';
  await setup('', memory);
  expect(syncMock.rows).toHaveLength(0);
  await elements['btn-import-guest'].fire('click');
  const choices = elements['guest-import'].children.filter(n => n.children.length === 2);
  expect(choices).toHaveLength(2);
  expect((choices[0].children[0] as Element & { checked?: boolean }).checked).not.toBe(true);
  Object.assign(choices[0].children[0], { checked: true });
  await elements['guest-import'].children.at(-1)!.fire('click');
  await Promise.resolve(); await Promise.resolve();
  expect(syncMock.rows.map(r => r.id)).toEqual(['guest-first']);
  expect(elements['sync-status'].textContent).toContain('Сохранено в аккаунте: 1');
  expect(JSON.parse(memory.getItem('neurohand:progress:v3')!).history).toHaveLength(2);
  await elements['btn-history'].fire('click');
  const text = (n: Element): string => n.textContent + n.children.map(text).join(' ');
  expect(text(elements.history)).toContain('Сохранено в аккаунте');
  await elements['btn-import-guest'].fire('click');
  Object.assign(elements['guest-import'].children.filter(n => n.children.length === 2)[0].children[0], { checked: true });
  await elements['guest-import'].children.at(-1)!.fire('click'); await Promise.resolve();
  expect(syncMock.rows).toHaveLength(1);
});

it.each([
  ['VITE_ENABLE_OPPOSITION', 'opposition', 'card-pairs', 'option-pairs', 'card-ring'],
  ['VITE_ENABLE_RING', 'ring', 'card-ring', 'option-ring', 'card-pairs'],
])('disables %s independently and blocks a forged selection without starting the camera', async (flag, mode, card, option, other) => {
  vi.stubEnv(flag, 'false');
  const memory = memoryStorage(); await setup('', memory);
  expect(elements[card].hidden).toBe(true);
  expect(elements[option].disabled).toBe(true);
  expect(elements[other].hidden).toBe(false);
  Object.assign(elements['training-choice'], { value: mode });
  await elements['btn-start'].fire('click');
  expect(mocks.camera).not.toHaveBeenCalled();
  expect(memory.getItem('neurohand:progress:v3')).toBeNull();
  Object.assign(elements['training-choice'], { value: 'guided' });
  await elements['btn-start'].fire('click');
  expect(mocks.camera).toHaveBeenCalledTimes(1);
});

it('preserves disabled ring progress on reload and allows finalizing it before a basic session', async () => {
  const { createRingSession } = await import('../src/session');
  const memory = memoryStorage();
  const current = createRingSession(8);
  memory.setItem('neurohand:progress:v3', JSON.stringify({ schemaVersion: 3, current, history: [] }));
  vi.stubEnv('VITE_ENABLE_RING', 'false');
  await setup('', memory);
  expect(elements.results.querySelector('#btn-resume')!.disabled).toBe(true);
  expect(mocks.camera).not.toHaveBeenCalled();
  expect(JSON.parse(memory.getItem('neurohand:progress:v3')!).current.id).toBe(current.id);
  await elements.results.querySelector('#btn-finish')!.fire('click');
  const archived = JSON.parse(memory.getItem('neurohand:progress:v3')!);
  expect(archived.history[0].id).toBe(current.id);
  expect(archived.history[0].mode).toBe('ring');
  await elements.results.querySelector('#btn-new')!.fire('click');
  await elements['btn-start'].fire('click');
  expect(JSON.parse(memory.getItem('neurohand:progress:v3')!).current.mode).toBe('guided');
});

it('uses unique release card IDs on the matching new exercises in the real HTML', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  expect(html.match(/<article id="card-pairs">[\s\S]*?<\/article>/)?.[0]).toContain('id="btn-choose-pairs"');
  expect(html.match(/<article id="card-ring">[\s\S]*?<\/article>/)?.[0]).toContain('id="btn-choose-ring"');
});

it('shows one goal completed on the third evaluated attempt and restores its detailed results', async () => {
  const memory = memoryStorage(); await setup('',memory);
  await elements['btn-choose-pairs'].fire('click');
  Object.assign(elements['pair-12'], { checked:true });
  await elements['btn-start'].fire('click'); prepare();
  for (let attempt=0;attempt<2;attempt++) {
    for (let i=0;i<22;i++) frame(pairPose(8));
    for (let i=0;i<30;i++) frame(fixture('grip_open'));
  }
  expect(elements['program-status'].textContent).toContain('Цель 1 из 2 · Попытка 3');
  for (let i=0;i<20;i++) frame(pairPose(12));
  expect(elements['program-status'].textContent).toContain('Выполнено с третьей попытки');
  await elements['btn-results'].fire('click');
  const text = (node:Element):string => node.textContent + node.children.map(text).join(' ');
  expect(text(elements.results)).toContain('Оценено: 3');
  expect(text(elements.results)).toContain('Цели выполнены: 1 / 2');
  expect(text(elements.results)).toContain('Выполнено с третьей попытки');
  vi.resetModules(); await setup('',memory);
  expect(text(elements.results)).toContain('Оценено: 3');
  expect(text(elements.results)).toContain('Выполнено с третьей попытки');
});

it('manually selects a non-thumb pair and highlights exactly its two tips', async () => {
  const memory = memoryStorage(); await setup('',memory);
  await elements['btn-choose-pairs'].fire('click');
  Object.assign(elements['pair-8-16'],{checked:true});
  await elements['btn-start'].fire('click'); prepare();
  const s=JSON.parse(memory.getItem('neurohand:progress:v3')!).current;
  expect(s.opposition.allowed).toEqual(['8-16']);
  expect(elements['task-description'].textContent).toContain('Экспериментальный');
  expect(elements['guide-tip-4'].classes.has('selected')).toBe(false);
  expect(elements['guide-tip-8'].classes.has('selected')).toBe(true);
  expect(elements['guide-tip-16'].classes.has('selected')).toBe(true);
  expect(mocks.draw.mock.lastCall![3].pair).toEqual([8,16]);
});

it('keeps the camera running across selected basic → pairs → ring blocks and shows final linked results',async()=>{
 const memory=memoryStorage();await setup('',memory);
 Object.assign(elements['automatic-flow'],{checked:true});Object.assign(elements['route-opposition'],{checked:true});Object.assign(elements['route-ring'],{checked:true});
 Object.assign(elements['pair-8'],{checked:true});Object.assign(elements['ring-tip'],{value:'8'});
 await elements['btn-start'].fire('click');prepare();
 for(let goal=0;goal<13+2+1;goal++) {
  await elements['btn-skip-pair'].fire('click');
  for(let i=0;i<110;i++) frame(fixture('grip_open'));
 }
 expect(elements.results.hidden).toBe(false);expect(mocks.camera).toHaveBeenCalledOnce();expect(mocks.stop).toHaveBeenCalledOnce();
 const finals=JSON.parse(memory.getItem('neurohand:progress:v3')!).history;
 expect(finals).toHaveLength(3);expect(new Set(finals.map((s:any)=>s.attempts.route.trainingRunId)).size).toBe(1);
 expect(finals.every((s:any)=>s.status==='completed' && !s.attempts.records.length && s.attempts.flow.goals.every((g:any)=>g.reason==='manual_skip'))).toBe(true);
});

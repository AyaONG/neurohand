import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Landmark } from "../src/types";

const mocks = vi.hoisted(() => ({
  detect: vi.fn(), close: vi.fn(), stop: vi.fn(), draw: vi.fn(), dump: vi.fn(),
}));
vi.mock("../src/camera", () => ({
  initCamera: async () => ({ getTracks: () => [{ stop: mocks.stop, addEventListener: vi.fn() }] }),
  initTracker: async () => ({ detectForVideo: mocks.detect, close: mocks.close }),
}));
vi.mock("../src/draw", () => ({
  drawHandOverlay: mocks.draw,
  mirrorPoint: (p: { x: number; y: number }, width: number) => ({ x: width - p.x, y: p.y }),
}));
vi.mock("../src/debug", () => ({ updateDebug: vi.fn(), dumpCapture: mocks.dump }));

// Minimal DOM adapter: tests the real app event handlers and session/FSM wiring.
// This is simulated input, not a browser/camera check. No storage is touched.
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
  append(...items: Element[]) { this.children.push(...items); }
  replaceChildren(...items: Element[]) { this.children = items; }
  focus() {}
  closest() { return this; }
  querySelectorAll() { return this.children.filter(child => !!child.dataset.mode); }
  querySelector(selector: string) { return this.children.find(child => selector.includes(`"${child.dataset.mode}"`)); }
}

const fixture = (name: string): Landmark[] => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
let elements: Record<string, Element>;
let modes: Record<string, Element>;
let video: Element & { videoWidth: number; videoHeight: number; readyState: number; currentTime: number };
let nextFrame: FrameRequestCallback | null;
let time: number;

async function setup(search = "") {
  elements = Object.fromEntries(["video", "canvas", "stage", "hint", "score", "debug", "btn-start", "btn-calibrate", "btn-dump", "tabs", "panel", "results", "btn-results"]
    .map(id => [id, Object.assign(new Element(), { id })]));
  elements.results.hidden = true;
  modes = Object.fromEntries(["pinch", "grip", "hold"].map(mode => [mode, Object.assign(new Element(), { dataset: { mode } })]));
  elements.tabs.children = Object.values(modes);
  video = Object.assign(elements.video, { videoWidth: 640, videoHeight: 480, readyState: 2, currentTime: 0 });
  Object.assign(elements.canvas, { width: 640, height: 480, getContext: () => ({ clearRect: vi.fn() }) });
  const document = Object.assign(new Element(), {
    querySelector: (selector: string) => elements[selector.slice(1)], createElement: () => new Element(),
  });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", new Element());
  vi.stubGlobal("location", { search });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => { nextFrame = null; });
  await import("../src/main");
}

function frame(lm: Landmark[] | null) {
  time += 33;
  video.currentTime = time / 1000;
  mocks.detect.mockReturnValue({ landmarks: lm ? [lm] : [] });
  const callback = nextFrame;
  nextFrame = null;
  callback?.(time);
}

function pinch() {
  for (let i = 0; i < 4; i++) frame(fixture("pinch_open"));
  for (let i = 0; i < 4; i++) frame(fixture("pinch_closed"));
}

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); nextFrame = null; time = 1000; });
afterEach(() => { vi.unstubAllGlobals(); });

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
    expect(elements.stage.hidden).toBe(false);
    expect(nextFrame).toBeNull();
  });

  it("counts three pinches once, celebrates, freezes results, and requires reopening after resume", async () => {
    await setup();
    await elements["btn-start"].fire("click");
    for (let rep = 1; rep <= 3; rep++) {
      pinch();
      expect(elements.score.textContent).toBe(`Пинцет: ${rep}`);
      expect(elements.hint.textContent).toBe(`✓ Захват засчитан · ${rep}`);
      expect(mocks.draw.mock.lastCall?.[3].success).toBe(true);
    }
    for (let i = 0; i < 160; i++) frame(fixture("pinch_closed"));
    expect(elements.score.textContent).toBe("Пинцет: 3");
    expect(elements.hint.textContent).toBe("Разведи пальцы для следующего захвата");
    expect(mocks.draw.mock.lastCall?.[3].success).toBe(false);
    await elements["btn-results"].fire("click");
    const snapshot = elements.results.children[2].children.map(row => row.textContent);
    expect(snapshot).toEqual(["Пинцет: 3", "Сжатия: Не начато", "Перенос: Не начато"]);
    const calls = mocks.detect.mock.calls.length;
    pinch();
    expect(mocks.detect.mock.calls.length).toBe(calls);
    expect(elements.results.children[2].children.map(row => row.textContent)).toEqual(snapshot);
    await elements["btn-results"].fire("click");
    for (let i = 0; i < 20; i++) frame(fixture("pinch_closed"));
    expect(elements.score.textContent).toBe("Пинцет: 3");
    pinch();
    expect(elements.score.textContent).toBe("Пинцет: 4");
    await elements.tabs.fire("click", { target: modes.grip });
    expect(elements.score.textContent).toBe("Эспандер: 0");
    await elements.tabs.fire("click", { target: modes.pinch });
    expect(elements.score.textContent).toBe("Пинцет: 4");
  });

  it("keeps both debug surfaces and Dump off by default, and enables them explicitly", async () => {
    await setup();
    expect(elements.debug.hidden).toBe(true);
    expect(elements["btn-dump"].hidden).toBe(true);
    await elements["btn-start"].fire("click");
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
  });

  it("supports the debug query flag without making it a persisted preference", async () => {
    await setup("?debug=1");
    expect(elements.debug.hidden).toBe(false);
    expect(elements["btn-dump"].hidden).toBe(false);
  });
});

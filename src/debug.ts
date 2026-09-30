import type { HandGeometry } from "./geometry";

export type Capture = {
  timestamp: number;
  exercise: string;
  videoWidth: number;
  videoHeight: number;
  landmarks: { x: number; y: number; z: number }[];
  observedReading: { open: boolean; closed: boolean; error: { code: string; joints: number[]; message: string } | null };
};

export function updateDebug(element: HTMLElement, g: HandGeometry | null, fps: number, extra: Record<string, string | number | null>): void {
  const values = g ? {
    "nd(4,8)": g.nd(4, 8), "nd(4,12)": g.nd(4, 12),
    "nd(4,16)": g.nd(4, 16), "nd(4,20)": g.nd(4, 20),
    "curl(8)": g.curl(8), "curl(12)": g.curl(12),
    "curl(16)": g.curl(16), "curl(20)": g.curl(20),
    handSize: g.handSize, handSizeNorm: g.handSizeNorm,
  } : { hand: "Рука не видна" };
  element.textContent = Object.entries({ fps, ...values, ...extra })
    .map(([key, value]) => `${key}: ${typeof value === "number" ? value.toFixed(3) : value ?? "—"}`).join("\n");
}

/** Explicit user download only; never stores images or sends data to a server. */
export function dumpCapture(capture: Capture): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(capture, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `capture_${capture.timestamp}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

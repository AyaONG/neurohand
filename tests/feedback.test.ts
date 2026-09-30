import { describe, expect, it } from "vitest";
import { getFeedback } from "../src/feedback";

const input = {
  exercise: "pinch" as const, timestampMs: 1000, visible: true, error: null,
  phase: "CONFIRMED" as const,
  success: { exercise: "pinch" as const, reps: 3, at: 1000 },
  instruction: "Общая инструкция",
};

describe("success feedback", () => {
  it("keeps the message across frames for 900 ms, the color for 500 ms, then asks for reopening", () => {
    for (const elapsed of [0, 16, 250, 499]) {
      expect(getFeedback({ ...input, timestampMs: 1000 + elapsed })).toMatchObject({
        text: "✓ Захват засчитан · 3", success: true, celebrating: true,
      });
    }
    for (const elapsed of [500, 899]) expect(getFeedback({ ...input, timestampMs: 1000 + elapsed }))
      .toMatchObject({ text: "✓ Захват засчитан · 3", success: false, celebrating: true });
    for (const elapsed of [900, 5000]) expect(getFeedback({ ...input, timestampMs: 1000 + elapsed }))
      .toMatchObject({ text: "Разведи пальцы для следующего захвата", success: false, celebrating: false });
  });

  it("does not invent success from CONFIRMED or a missing error, or carry it to another mode", () => {
    expect(getFeedback({ ...input, success: null }).celebrating).toBe(false);
    expect(getFeedback({ ...input, success: null, phase: "ARMED" }).text).toBe("Общая инструкция");
    expect(getFeedback({ ...input, exercise: "grip" }).text).toBe("Раскрой кисть для следующего сжатия");
  });

  it("gives lost tracking and actual errors priority over success", () => {
    const error = { code: "WRONG_FINGER" as const, joints: [12], message: "technical message" };
    expect(getFeedback({ ...input, error })).toMatchObject({
      text: "Соедини большой и указательный пальцы", success: false, error: true,
    });
    expect(getFeedback({ ...input, error, visible: false })).toMatchObject({
      text: "Рука не видна. Верни ладонь в кадр", success: false, error: false,
    });
  });
});

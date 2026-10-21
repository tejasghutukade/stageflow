import { describe, expect, it } from "vitest";
import { mapPoint } from "./coords";

describe("mapPoint", () => {
  const rect = { left: 100, top: 50, width: 640, height: 360 };

  it("scales by decoded image size over displayed size", () => {
    expect(mapPoint({ clientX: 420, clientY: 230 }, rect, { width: 1280, height: 720 })).toEqual({ x: 640, y: 360 });
  });

  it("follows a frame size change after a popup (metadata never consulted)", () => {
    const popup = { width: 800, height: 577 };
    const p = mapPoint({ clientX: 740, clientY: 410 }, rect, popup);
    expect(p).toEqual({ x: 800, y: 577 });
    expect(mapPoint({ clientX: 100, clientY: 50 }, rect, popup)).toEqual({ x: 0, y: 0 });
  });

  it("clamps outside points and rejects unknown sizes", () => {
    expect(mapPoint({ clientX: -50, clientY: 9999 }, rect, { width: 1280, height: 720 })).toEqual({ x: 0, y: 720 });
    expect(mapPoint({ clientX: 1, clientY: 1 }, rect, null)).toBeNull();
    expect(mapPoint({ clientX: 1, clientY: 1 }, { ...rect, width: 0 }, { width: 10, height: 10 })).toBeNull();
  });
});

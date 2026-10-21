import { describe, expect, it } from "vitest";
import { registerInput, type EventTargetLike, type TextareaLike } from "./inputHandlers";
import type { LiveViewInput } from "./types";

class FakeTarget implements EventTargetLike {
  handlers = new Map<string, ((e: any) => void)[]>();
  addEventListener(type: string, fn: (e: any) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: (e: any) => void) {
    this.handlers.set(type, (this.handlers.get(type) ?? []).filter((h) => h !== fn));
  }
  fire(type: string, e: Record<string, unknown> = {}) {
    const event = { preventDefault() { (event as any).prevented = true; }, prevented: false, ...e };
    for (const h of this.handlers.get(type) ?? []) h(event);
    return event as { prevented: boolean };
  }
  count() {
    return [...this.handlers.values()].reduce((n, h) => n + h.length, 0);
  }
}

class FakeTextarea extends FakeTarget implements TextareaLike {
  value = "";
  focused = false;
  focusOptions: FocusOptions | undefined;
  focus(options?: FocusOptions) {
    this.focused = true;
    this.focusOptions = options;
  }
}

function setup(mode: "control" | "view" = "control") {
  const canvas = new FakeTarget();
  const win = new FakeTarget();
  const textarea = new FakeTextarea();
  const sent: LiveViewInput[] = [];
  let clock = 1000;
  let timer: (() => void) | undefined;
  const detach = registerInput({
    mode,
    canvas,
    textarea,
    win,
    getRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
    getImageSize: () => ({ width: 800, height: 600 }),
    send: (e) => sent.push(e),
    now: () => clock,
    setTimer: (fn) => {
      timer = fn;
      return () => {
        timer = undefined;
      };
    },
  });
  return { canvas, win, textarea, sent, detach, advance: (ms: number) => (clock += ms), fireTimer: () => timer?.() };
}

describe("registerInput", () => {
  it("view mode registers no handlers at all", () => {
    const h = setup("view");
    expect(h.canvas.count() + h.win.count() + h.textarea.count()).toBe(0);
  });

  it("control mode maps clicks by image size and focuses the textarea", () => {
    const h = setup();
    const e = h.canvas.fire("mousedown", { clientX: 100, clientY: 50, button: 0, detail: 2 });
    expect(e.prevented).toBe(true);
    expect(h.textarea.focused).toBe(true);
    expect(h.textarea.focusOptions).toEqual({ preventScroll: true });
    expect(h.sent[0]).toMatchObject({ eventType: "mousePressed", x: 200, y: 100, button: "left", clickCount: 2 });
    h.win.fire("mouseup", { clientX: 100, clientY: 50, button: 0, detail: 2 });
    expect(h.sent[1]).toMatchObject({ eventType: "mouseReleased", button: "left" });
  });

  it("sends right button, suppresses the context menu, ignores unpaired mouseup", () => {
    const h = setup();
    expect(h.canvas.fire("contextmenu").prevented).toBe(true);
    h.win.fire("mouseup", { clientX: 1, clientY: 1, button: 2 });
    expect(h.sent).toHaveLength(0);
    h.canvas.fire("mousedown", { clientX: 1, clientY: 1, button: 2 });
    expect(h.sent[0]).toMatchObject({ button: "right" });
  });

  it("sends wheel with deltas and blocks page scroll", () => {
    const h = setup();
    const e = h.canvas.fire("wheel", { clientX: 10, clientY: 10, deltaX: 0, deltaY: 120, deltaMode: 0 });
    expect(e.prevented).toBe(true);
    expect(h.sent[0]).toMatchObject({ eventType: "mouseWheel", deltaY: 120 });
  });

  it("throttles mouseMoved to the latest with a trailing send", () => {
    const h = setup();
    h.canvas.fire("mousemove", { clientX: 2, clientY: 2 });
    h.canvas.fire("mousemove", { clientX: 4, clientY: 4 });
    h.canvas.fire("mousemove", { clientX: 6, clientY: 6 });
    expect(h.sent).toHaveLength(1);
    h.advance(60);
    h.fireTimer();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatchObject({ eventType: "mouseMoved", x: 12 });
  });

  it("keyboard: handled keys are prevented; paste chord and composing are left alone", () => {
    const h = setup();
    const key = { key: "a", code: "KeyA", keyCode: 65, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(h.textarea.fire("keydown", key).prevented).toBe(true);
    expect(h.sent[0]).toMatchObject({ eventType: "keyDown", text: "a" });
    expect(h.textarea.fire("keydown", { ...key, key: "v", metaKey: true }).prevented).toBe(false);
    expect(h.textarea.fire("keydown", { ...key, isComposing: true }).prevented).toBe(false);
    expect(h.sent).toHaveLength(1);
  });

  it("text input becomes char events and clears the textarea; composition waits for its end", () => {
    const h = setup();
    h.textarea.value = "p@s";
    h.textarea.fire("input", { isComposing: false });
    expect(h.sent.map((e) => (e as any).text)).toEqual(["p", "@", "s"]);
    expect(h.textarea.value).toBe("");
    h.textarea.value = "あ";
    h.textarea.fire("input", { isComposing: true });
    expect(h.sent).toHaveLength(3);
    h.textarea.fire("compositionend");
    expect(h.sent).toHaveLength(4);
  });

  it("detach removes every handler", () => {
    const h = setup();
    h.detach();
    expect(h.canvas.count() + h.win.count() + h.textarea.count()).toBe(0);
  });
});

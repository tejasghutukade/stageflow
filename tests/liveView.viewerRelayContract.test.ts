import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_INPUT_BATCH, DEFAULT_MAX_INPUT_EVENTS_PER_SECOND, validEvent } from "../src/browser/agentBrowserLiveViewRelay.js";
import { registerInput, type EventTargetLike, type TextareaLike } from "../ui/src/liveView/inputHandlers.js";
import { DEFAULT_EVENTS_PER_SECOND, DEFAULT_MAX_BATCH } from "../ui/src/liveView/inputQueue.js";
import { textToCharEvents } from "../ui/src/liveView/keys.js";

class Target implements EventTargetLike {
  handlers = new Map<string, ((e: any) => void)[]>();
  addEventListener(type: string, fn: (e: any) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  fire(type: string, e: Record<string, unknown> = {}) {
    for (const h of this.handlers.get(type) ?? []) h({ preventDefault() {}, ...e });
  }
}

class Textarea extends Target implements TextareaLike {
  value = "";
  focus() {}
}

function emitEverything(): unknown[] {
  const canvas = new Target();
  const win = new Target();
  const textarea = new Textarea();
  const sent: unknown[] = [];
  let clock = 0;
  registerInput({
    mode: "control",
    canvas,
    textarea,
    win,
    getRect: () => ({ left: 0, top: 0, width: 400, height: 300 }),
    getImageSize: () => ({ width: 800, height: 600 }),
    send: (e) => sent.push(e),
    now: () => (clock += 100),
    setTimer: () => () => {},
  });
  for (const button of [0, 1, 2]) {
    canvas.fire("mousedown", { clientX: 10, clientY: 20, button, detail: 3 });
    win.fire("mouseup", { clientX: 10, clientY: 20, button, detail: 3 });
  }
  canvas.fire("mousemove", { clientX: 5, clientY: 5 });
  canvas.fire("mousemove", { clientX: 399, clientY: 299 });
  canvas.fire("wheel", { clientX: 10, clientY: 10, deltaX: -3, deltaY: 120, deltaMode: 0 });
  canvas.fire("wheel", { clientX: 10, clientY: 10, deltaX: 0, deltaY: 3, deltaMode: 1 });
  const mods = { altKey: true, ctrlKey: true, metaKey: true, shiftKey: true };
  const keys = ["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowLeft", "ArrowUp", "Home", "End", "PageDown", "F5", "a", "A", " ", "é", "Dead"];
  for (const key of keys) {
    for (const extra of [{}, mods]) {
      const e = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, keyCode: key.charCodeAt(0), isComposing: false, ...extra };
      textarea.fire("keydown", e);
      textarea.fire("keyup", e);
    }
  }
  textarea.value = "héllo 😀 wörld";
  textarea.fire("input", { isComposing: false });
  textarea.fire("compositionend");
  return [...sent, ...textToCharEvents("日本語 😀 mixed\n\ttext")];
}

describe("viewer events vs relay validator", () => {
  const events = emitEverything();

  it("the viewer emitted every input family", () => {
    const kinds = new Set(events.map((e) => `${(e as any).type}:${(e as any).eventType}`));
    for (const k of [
      "input_mouse:mousePressed",
      "input_mouse:mouseReleased",
      "input_mouse:mouseMoved",
      "input_mouse:mouseWheel",
      "input_keyboard:keyDown",
      "input_keyboard:keyUp",
      "input_keyboard:char",
    ]) {
      expect(kinds).toContain(k);
    }
  });

  it("the relay accepts every event the viewer can emit", () => {
    expect(events.filter((e) => !validEvent(e))).toEqual([]);
  });

  it("viewer batch size and pacing stay within the relay limits", () => {
    expect(DEFAULT_MAX_BATCH).toBeLessThanOrEqual(DEFAULT_MAX_INPUT_BATCH);
    expect(DEFAULT_EVENTS_PER_SECOND).toBeLessThan(DEFAULT_MAX_INPUT_EVENTS_PER_SECOND);
  });
});

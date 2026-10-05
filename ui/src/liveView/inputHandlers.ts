import { mapPoint } from "./coords";
import { buildKeyEvent, isPasteChord, modifierMask, textToCharEvents, type KeyEventLike } from "./keys";
import type { ImageSize, LiveViewInput, LiveViewMode, MouseButton, ViewRect } from "./types";

type Listener = (e: any) => void;

export type EventTargetLike = {
  addEventListener(type: string, listener: Listener, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: Listener, options?: boolean | EventListenerOptions): void;
};

export type TextareaLike = EventTargetLike & { value: string; focus(): void };

export type RegisterInputOptions = {
  mode: LiveViewMode;
  canvas: EventTargetLike;
  textarea: TextareaLike | null;
  win: EventTargetLike;
  getRect(): ViewRect;
  getImageSize(): ImageSize | null;
  send(event: LiveViewInput): void;
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
  moveIntervalMs?: number;
};

const BUTTONS: MouseButton[] = ["left", "middle", "right"];
const MAX_DELTA = 100_000;

function clampDelta(v: number): number {
  return Math.max(-MAX_DELTA, Math.min(MAX_DELTA, v));
}

function wheelScale(mode: number): number {
  return mode === 1 ? 40 : mode === 2 ? 800 : 1;
}

export function registerInput(options: RegisterInputOptions): () => void {
  if (options.mode !== "control") return () => undefined;
  const { canvas, textarea, win, send } = options;
  const interval = options.moveIntervalMs ?? 50;
  const pressed = new Set<number>();
  let pendingMove: LiveViewInput | null = null;
  let cancelMove: (() => void) | undefined;
  let lastMoveAt = -Infinity;

  const point = (e: { clientX: number; clientY: number }) =>
    mapPoint(e, options.getRect(), options.getImageSize());

  function flushMove(): void {
    cancelMove?.();
    cancelMove = undefined;
    if (pendingMove !== null) {
      send(pendingMove);
      lastMoveAt = options.now();
      pendingMove = null;
    }
  }

  const onMouseDown: Listener = (e) => {
    const p = point(e);
    if (p === null) return;
    e.preventDefault();
    textarea?.focus();
    flushMove();
    pressed.add(e.button);
    send({
      type: "input_mouse",
      eventType: "mousePressed",
      ...p,
      button: BUTTONS[e.button] ?? "left",
      clickCount: Math.min(3, Math.max(1, e.detail || 1)),
      modifiers: modifierMask(e),
    });
  };

  const onMouseUp: Listener = (e) => {
    if (!pressed.has(e.button)) return;
    pressed.delete(e.button);
    const p = point(e);
    if (p === null) return;
    flushMove();
    send({
      type: "input_mouse",
      eventType: "mouseReleased",
      ...p,
      button: BUTTONS[e.button] ?? "left",
      clickCount: Math.min(3, Math.max(1, e.detail || 1)),
      modifiers: modifierMask(e),
    });
  };

  const onMouseMove: Listener = (e) => {
    const p = point(e);
    if (p === null) return;
    pendingMove = { type: "input_mouse", eventType: "mouseMoved", ...p, modifiers: modifierMask(e) };
    const wait = lastMoveAt + interval - options.now();
    if (wait <= 0) {
      flushMove();
    } else if (cancelMove === undefined) {
      cancelMove = options.setTimer(() => {
        cancelMove = undefined;
        flushMove();
      }, wait);
    }
  };

  const onWheel: Listener = (e) => {
    e.preventDefault();
    const p = point(e);
    if (p === null) return;
    flushMove();
    const scale = wheelScale(e.deltaMode);
    send({
      type: "input_mouse",
      eventType: "mouseWheel",
      ...p,
      deltaX: clampDelta(e.deltaX * scale),
      deltaY: clampDelta(e.deltaY * scale),
      modifiers: modifierMask(e),
    });
  };

  const onContextMenu: Listener = (e) => e.preventDefault();

  const onKey = (eventType: "keyDown" | "keyUp"): Listener => (e: KeyEventLike & { preventDefault(): void }) => {
    if (isPasteChord(e)) return;
    const event = buildKeyEvent(e, eventType);
    if (event === null) return;
    e.preventDefault();
    send(event);
  };
  const onKeyDown = onKey("keyDown");
  const onKeyUp = onKey("keyUp");

  function flushText(): void {
    if (textarea === null || textarea.value === "") return;
    const value = textarea.value;
    textarea.value = "";
    for (const event of textToCharEvents(value)) send(event);
  }
  const onInput: Listener = (e) => {
    if (e.isComposing) return;
    flushText();
  };
  const onCompositionEnd: Listener = () => flushText();

  canvas.addEventListener("mousedown", onMouseDown);
  canvas.addEventListener("mousemove", onMouseMove);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", onContextMenu);
  win.addEventListener("mouseup", onMouseUp);
  textarea?.addEventListener("keydown", onKeyDown);
  textarea?.addEventListener("keyup", onKeyUp);
  textarea?.addEventListener("input", onInput);
  textarea?.addEventListener("compositionend", onCompositionEnd);

  return () => {
    cancelMove?.();
    canvas.removeEventListener("mousedown", onMouseDown);
    canvas.removeEventListener("mousemove", onMouseMove);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("contextmenu", onContextMenu);
    win.removeEventListener("mouseup", onMouseUp);
    textarea?.removeEventListener("keydown", onKeyDown);
    textarea?.removeEventListener("keyup", onKeyUp);
    textarea?.removeEventListener("input", onInput);
    textarea?.removeEventListener("compositionend", onCompositionEnd);
  };
}

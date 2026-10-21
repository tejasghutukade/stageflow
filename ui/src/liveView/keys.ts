import type { KeyboardInput } from "./types";

export const MAX_FIELD_LENGTH = 32;

export type KeyEventLike = {
  key: string;
  code: string;
  keyCode: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
};

export function modifierMask(e: Pick<KeyEventLike, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

export function isPasteChord(e: KeyEventLike): boolean {
  return (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v";
}

function isPrintable(e: KeyEventLike): boolean {
  if (Array.from(e.key).length !== 1) return false;
  if (e.metaKey) return false;
  return !e.ctrlKey || e.altKey;
}

export function buildKeyEvent(e: KeyEventLike, eventType: "keyDown" | "keyUp"): KeyboardInput | null {
  if (e.isComposing === true || e.keyCode === 229) return null;
  if (isPasteChord(e)) return null;
  const out: KeyboardInput = { type: "input_keyboard", eventType };
  if (e.key.length <= MAX_FIELD_LENGTH) out.key = e.key;
  if (e.code.length <= MAX_FIELD_LENGTH) out.code = e.code;
  if (Number.isInteger(e.keyCode) && e.keyCode >= 0 && e.keyCode <= 255) out.windowsVirtualKeyCode = e.keyCode;
  out.modifiers = modifierMask(e);
  if (eventType === "keyDown") {
    if (isPrintable(e)) out.text = e.key;
    else if (e.key === "Enter") out.text = "\r";
  }
  return out;
}

export function textToCharEvents(text: string): KeyboardInput[] {
  const events: KeyboardInput[] = [];
  for (const ch of Array.from(text)) {
    events.push({ type: "input_keyboard", eventType: "char", text: ch === "\n" ? "\r" : ch });
  }
  return events;
}

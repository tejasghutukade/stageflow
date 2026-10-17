/** Keyboard cursor over a list of rows: -1 means no row is highlighted yet. */
export type CursorKey = "ArrowDown" | "ArrowUp";

export function isCursorKey(key: string): key is CursorKey {
  return key === "ArrowDown" || key === "ArrowUp";
}

/** Next cursor for an arrow key. Stays -1 for an empty list; the first press lands on a row. */
export function moveCursor(cursor: number, key: CursorKey, count: number): number {
  if (count <= 0) return -1;
  return key === "ArrowDown" ? Math.min(count - 1, cursor + 1) : Math.max(0, cursor - 1);
}

/** Keep a cursor valid after the list shrinks (filter or search changed). */
export function clampCursor(cursor: number, count: number): number {
  if (count <= 0) return -1;
  return Math.min(cursor, count - 1);
}

/**
 * Arrow keys move the row cursor unless the user is typing or on a control of their own:
 * inputs, buttons, and links other than the row links themselves.
 */
export function shouldHandleCursorKey(target: { tagName: string; isContentEditable?: boolean; dataset?: DOMStringMap }): boolean {
  if (target.isContentEditable) return false;
  const tag = target.tagName.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "BUTTON") return false;
  if (tag === "A") return target.dataset?.listRow !== undefined;
  return true;
}

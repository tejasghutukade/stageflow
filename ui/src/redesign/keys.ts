import { useEffect, useRef } from "react";

export type HotkeyScope =
  | "global"
  | "inbox"
  | "inbox-gate"
  | "runs"
  | "run-detail"
  | "run-detail-gate"
  | "tasks"
  | "pipelines"
  | "workshop"
  | "triggers"
  | "catalog";

export type HotkeyDef = {
  key: string;
  scope: HotkeyScope;
  when?: () => boolean;
  allowInInput?: boolean;
  handler: (e: KeyboardEvent) => void;
};

const SCOPE_ORDER: HotkeyScope[] = [
  "run-detail-gate",
  "inbox-gate",
  "run-detail",
  "runs",
  "tasks",
  "pipelines",
  "workshop",
  "triggers",
  "catalog",
  "inbox",
  "global",
];

type Registration = {
  id: number;
  scope: HotkeyScope;
  defs: HotkeyDef[];
};

let nextId = 1;
const registrations: Registration[] = [];

export function normalizeHotkeyKey(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const base = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  parts.push(base);
  return parts.join("+");
}

function defKey(def: HotkeyDef): string {
  return def.key.toLowerCase();
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SELECT") return true;
  return target.isContentEditable;
}

export function dispatchHotkeys(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  const pressed = normalizeHotkeyKey(e);
  const typing = isTypingTarget(e.target);

  for (const scope of SCOPE_ORDER) {
    for (let i = registrations.length - 1; i >= 0; i--) {
      const reg = registrations[i];
      if (reg.scope !== scope) continue;
      for (const def of reg.defs) {
        if (def.scope !== scope) continue;
        if (defKey(def) !== pressed) continue;
        if (def.when && !def.when()) continue;
        if (typing && !def.allowInInput) continue;
        def.handler(e);
        if (e.defaultPrevented) return;
      }
    }
  }
}

let listenerAttached = false;

function ensureListener(): void {
  if (listenerAttached || typeof window === "undefined") return;
  listenerAttached = true;
  window.addEventListener("keydown", dispatchHotkeys);
}

export function useHotkeys(defs: HotkeyDef[], scope: HotkeyScope): void {
  const defsRef = useRef(defs);
  defsRef.current = defs;
  const regRef = useRef<Registration | null>(null);

  useEffect(() => {
    ensureListener();
    const id = nextId++;
    const reg: Registration = { id, scope, defs: defsRef.current };
    regRef.current = reg;
    registrations.push(reg);

    return () => {
      const idx = registrations.findIndex((r) => r.id === id);
      if (idx >= 0) registrations.splice(idx, 1);
      regRef.current = null;
    };
  }, [scope]);

  useEffect(() => {
    if (regRef.current) regRef.current.defs = defsRef.current;
  });
}

import { useSyncExternalStore } from "react";
import { evalEditPath, evalPath, evalRunPath, type Route } from "../../../routes";
import { compareIntentKey, parseCompareIntent } from "./liveProgressModel";

export type RunDialogTarget = { evalId: string; projectRoot?: string };

let current: RunDialogTarget | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function openRunDialog(evalId: string, projectRoot?: string): void {
  current = { evalId, ...(projectRoot ? { projectRoot } : {}) };
  emit();
}

export function closeRunDialog(): void {
  if (current === null) return;
  current = null;
  emit();
}

export function currentRunDialogTarget(): RunDialogTarget | null {
  return current;
}

export function useRunDialogTarget(): RunDialogTarget | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}

export function openRunTargetFromRoute(route: Route): RunDialogTarget | null {
  if ((route.name === "evalDetail" || route.name === "evalEdit" || route.name === "evalRun") && route.openRun) {
    return { evalId: route.evalId };
  }
  return null;
}

export function pathWithoutOpenRun(route: Route): string | null {
  if (route.name === "evalDetail") return evalPath(route.evalId);
  if (route.name === "evalEdit") return evalEditPath(route.evalId);
  if (route.name === "evalRun") return evalRunPath(route.evalId, route.runNumber, route.tab ? { tab: route.tab } : undefined);
  return null;
}

export function saveCompareIntent(evalId: string, runNumber: number, compareWith: number): void {
  try {
    window.sessionStorage.setItem(compareIntentKey(evalId, runNumber), String(compareWith));
  } catch {
    /* storage unavailable */
  }
}

export function readCompareIntent(evalId: string, runNumber: number): number | null {
  try {
    return parseCompareIntent(window.sessionStorage.getItem(compareIntentKey(evalId, runNumber)));
  } catch {
    return null;
  }
}

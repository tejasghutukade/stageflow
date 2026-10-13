import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export const WORK_DEFAULT_H = 300;
export const WORK_MIN_H = 200;
/** Minimum height reserved for the upper timeline / graph / list band. */
export const UPPER_MIN_H = 140;
/** @deprecated use UPPER_MIN_H */
export const MAP_MIN_H = UPPER_MIN_H;
export const WORK_ARROW_STEP = 24;
export const RUN_DETAIL_WORK_H_STORAGE_KEY = "sf-run-detail-work-h";

export function clampWorkHeight(requested: number, paneHeight: number): number {
  const maxByUpper = paneHeight - UPPER_MIN_H;
  if (paneHeight < 340) return Math.max(0, maxByUpper);
  return Math.max(WORK_MIN_H, Math.min(requested, maxByUpper));
}

export function readStoredWorkHeight(): number | null {
  try {
    const raw = sessionStorage.getItem(RUN_DETAIL_WORK_H_STORAGE_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function persistWorkHeight(height: number): void {
  try {
    sessionStorage.setItem(RUN_DETAIL_WORK_H_STORAGE_KEY, String(height));
  } catch {
    /* ignore quota / private mode */
  }
}

export type WorkSplitGesture = { id: number; y: number; h: number };

export function useRunDetailWorkSplit(paneRef: RefObject<HTMLDivElement | null>) {
  const [workHeight, setWorkHeight] = useState(() => {
    const stored = readStoredWorkHeight();
    return stored ?? WORK_DEFAULT_H;
  });
  const [paneHeight, setPaneHeight] = useState(0);
  const [splitDragging, setSplitDragging] = useState(false);
  const splitGestureRef = useRef<WorkSplitGesture | null>(null);

  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const measure = () => setPaneHeight(el.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [paneRef]);

  const applyWorkHeight = useCallback(
    (requested: number) => {
      const height = paneRef.current?.getBoundingClientRect().height ?? paneHeight;
      const next = clampWorkHeight(requested, height);
      setWorkHeight(next);
      persistWorkHeight(next);
    },
    [paneHeight, paneRef],
  );

  const splitMax = Math.max(0, paneHeight - UPPER_MIN_H);
  const splitMin = paneHeight < 340 ? splitMax : WORK_MIN_H;

  return {
    workHeight,
    paneHeight,
    splitDragging,
    setSplitDragging,
    splitGestureRef,
    applyWorkHeight,
    splitMin,
    splitMax,
  };
}

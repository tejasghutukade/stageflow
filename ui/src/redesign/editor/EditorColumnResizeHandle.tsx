import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from "react";

export type EditorColumnResizeHandleProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  invert?: boolean;
  onChange: (next: number) => void;
};

export function EditorColumnResizeHandle({
  label,
  value,
  min,
  max,
  step = 32,
  invert = false,
  onChange,
}: EditorColumnResizeHandleProps) {
  const clamp = (next: number) => Math.max(min, Math.min(max, next));

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const originX = event.clientX;
    const originW = value;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== event.pointerId) return;
      const delta = ev.clientX - originX;
      onChange(clamp(invert ? originW - delta : originW + delta));
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== event.pointerId) return;
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onChange(clamp(invert ? value + step : value - step));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onChange(clamp(invert ? value - step : value + step));
    } else if (event.key === "Home") {
      event.preventDefault();
      onChange(invert ? max : min);
    } else if (event.key === "End") {
      event.preventDefault();
      onChange(invert ? min : max);
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      className="w-1.5 shrink-0 cursor-col-resize bg-[#ffffff12] hover:bg-[#ffffff24] focus-visible:bg-[#ffffff24] focus-visible:outline-none"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}

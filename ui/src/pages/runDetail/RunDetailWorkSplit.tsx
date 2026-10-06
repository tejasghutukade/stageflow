import type { RefObject } from "react";
import { WORK_ARROW_STEP, type WorkSplitGesture } from "./runDetailWorkSplit";

export function RunDetailWorkSplit({
  workHeight,
  splitMin,
  splitMax,
  splitDragging,
  setSplitDragging,
  splitGestureRef,
  applyWorkHeight,
}: {
  workHeight: number;
  splitMin: number;
  splitMax: number;
  splitDragging: boolean;
  setSplitDragging: (dragging: boolean) => void;
  splitGestureRef: RefObject<WorkSplitGesture | null>;
  applyWorkHeight: (requested: number) => void;
}) {
  return (
    <div
      className={`work-split${splitDragging ? " is-dragging" : ""}`}
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize workspace"
      aria-valuemin={splitMin}
      aria-valuemax={splitMax}
      aria-valuenow={Math.round(workHeight)}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button != null && event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setSplitDragging(true);
        splitGestureRef.current = {
          id: event.pointerId,
          y: event.clientY,
          h: workHeight,
        };
      }}
      onPointerMove={(event) => {
        const gesture = splitGestureRef.current;
        if (!gesture || gesture.id !== event.pointerId) return;
        applyWorkHeight(gesture.h + (gesture.y - event.clientY));
      }}
      onPointerUp={(event) => {
        if (splitGestureRef.current?.id !== event.pointerId) return;
        splitGestureRef.current = null;
        setSplitDragging(false);
      }}
      onPointerCancel={(event) => {
        if (splitGestureRef.current?.id !== event.pointerId) return;
        splitGestureRef.current = null;
        setSplitDragging(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowUp") {
          event.preventDefault();
          applyWorkHeight(workHeight + WORK_ARROW_STEP);
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          applyWorkHeight(workHeight - WORK_ARROW_STEP);
        }
        if (event.key === "Home") {
          event.preventDefault();
          applyWorkHeight(splitMax);
        }
        if (event.key === "End") {
          event.preventDefault();
          applyWorkHeight(splitMin);
        }
      }}
    >
      <span className="work-split__grip" aria-hidden="true"></span>
    </div>
  );
}

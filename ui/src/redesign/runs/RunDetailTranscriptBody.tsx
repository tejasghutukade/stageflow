import { useEffect, useRef, type ReactNode, type UIEvent } from "react";
import { isNearBottom } from "../../components/TranscriptStream";

export function RunDetailTranscriptBody({
  autoScroll,
  scrollKey,
  children,
}: {
  autoScroll?: boolean;
  scrollKey?: number | string;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    if (autoScroll) {
      stickToBottomRef.current = true;
    }
  }, [autoScroll]);

  useEffect(() => {
    if (!autoScroll || !stickToBottomRef.current) return;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [autoScroll, scrollKey]);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    stickToBottomRef.current = isNearBottom(event.currentTarget);
  }

  return (
    <div
      ref={bodyRef}
      onScroll={onScroll}
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-3"
    >
      {children}
    </div>
  );
}

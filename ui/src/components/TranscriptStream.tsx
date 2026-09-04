import { useEffect, useRef, type ReactNode, type UIEvent } from "react";

const NEAR_BOTTOM_PX = 64;

export type TranscriptStreamProps = {
  stageName: string;
  status?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
  composer?: ReactNode;
  autoScroll?: boolean;
  scrollKey?: number | string;
};

type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

export function isNearBottom(el: ScrollMetrics): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
}

export function TranscriptStream({
  stageName,
  status,
  trailing,
  children,
  composer,
  autoScroll,
  scrollKey,
}: TranscriptStreamProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
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

  function onBodyScroll(event: UIEvent<HTMLDivElement>) {
    stickToBottomRef.current = isNearBottom(event.currentTarget);
  }

  return (
    <div className="stream" style={{ height: "100%" }}>
      <header className="stream__head">
        <h3 className="stream__name">{stageName}</h3>
        {status}
        {trailing ? (
          <>
            <span className="topbar__spacer"></span>
            <div className="stream__head-trail">{trailing}</div>
          </>
        ) : null}
      </header>

      <div ref={bodyRef} className="stream__body" onScroll={onBodyScroll}>
        <div className="thread">
          {children}
        </div>
      </div>

      {composer}
    </div>
  );
}

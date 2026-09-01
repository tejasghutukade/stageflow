import { useEffect, useRef, type ReactNode } from "react";

export type TranscriptStreamProps = {
  stageName: string;
  status?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
  composer?: ReactNode;
  autoScroll?: boolean;
  scrollKey?: number | string;
};

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

  useEffect(() => {
    if (!autoScroll) return;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [autoScroll, scrollKey, children]);

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

      <div ref={bodyRef} className="stream__body">
        <div className="thread">
          {children}
        </div>
      </div>

      {composer}
    </div>
  );
}

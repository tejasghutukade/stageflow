import { useEffect, useRef, type ReactNode } from "react";

export type TranscriptStreamProps = {
  stageName: string;
  status?: ReactNode;
  children: ReactNode;
  composer?: ReactNode;
  autoScroll?: boolean;
  scrollKey?: number | string;
};

export function TranscriptStream({
  stageName,
  status,
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

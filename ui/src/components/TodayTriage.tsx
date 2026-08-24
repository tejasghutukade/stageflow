import type { ReactNode } from "react";

export type TriageStatus = "waiting" | "running" | "failed" | "succeeded";

export type TriageSection = {
  label: string;
  count: number;
  status: TriageStatus;
  children: ReactNode;
};

export type TodayTriageProps = {
  waiting: TriageSection;
  inFlight: TriageSection;
  broken: TriageSection;
  finished: TriageSection;
};

const DOT_CLASS: Record<TriageStatus, string> = {
  waiting: "dot dot--waiting",
  running: "dot dot--running",
  failed: "dot dot--failed",
  succeeded: "dot dot--succeeded",
};

function Zone({
  label,
  count,
  status,
  children,
}: {
  label: string;
  count: number;
  status: TriageStatus;
  children: ReactNode;
}) {
  return (
    <section className="zone">
      <div className="zone__head">
        <span className={DOT_CLASS[status]}></span>
        <span className="eyebrow">{label}</span>
        <span className="zone__rule"></span>
        <span className="zone__count">{count}</span>
      </div>
      {children}
    </section>
  );
}

export function TodayTriage({
  waiting,
  inFlight,
  broken,
  finished,
}: TodayTriageProps) {
  return (
    <>
      <Zone label={waiting.label} count={waiting.count} status={waiting.status}>
        {waiting.children}
      </Zone>
      <Zone label={inFlight.label} count={inFlight.count} status={inFlight.status}>
        {inFlight.children}
      </Zone>
      <Zone label={broken.label} count={broken.count} status={broken.status}>
        {broken.children}
      </Zone>
      <Zone label={finished.label} count={finished.count} status={finished.status}>
        {finished.children}
      </Zone>
    </>
  );
}

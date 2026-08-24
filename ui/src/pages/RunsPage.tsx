import { useMemo, useState } from "react";
import { useRunCatalog } from "../catalog/useRunCatalog";
import {
  bucketViews,
  runsFilterCounts,
  type RunsFilterCounts,
} from "../catalog/views";
import { miniTrackLabel, relativeTime } from "../catalogJoin";
import { MiniTrack } from "../components/MiniTrack";
import { cssStatusToken, runDisplayStatus } from "../status/runStatus";

type StatusFilter = "all" | "waiting" | "running" | "failed" | "finished";

const FILTER_LABEL: Record<StatusFilter, (c: RunsFilterCounts) => string> = {
  all: (c) => `All ${c.all}`,
  waiting: (c) => `Waiting ${c.waiting}`,
  running: (c) => `Running ${c.running}`,
  failed: (c) => `Failed ${c.failed}`,
  finished: (c) => `Finished ${c.finished}`,
};

export function RunsPage({
  onOpen,
  onNew,
}: {
  onOpen: (runId: string) => void;
  onNew: () => void;
}) {
  const { snapshot, error, loading } = useRunCatalog();
  const [filter, setFilter] = useState<StatusFilter>("all");

  const runs = snapshot.runs;
  const counts = runsFilterCounts(snapshot);
  const buckets = bucketViews(snapshot);
  const visible = useMemo(() => {
    if (filter === "all") return runs;
    return {
      waiting: buckets.waiting,
      running: buckets.inFlight,
      failed: buckets.broken,
      finished: buckets.finished,
    }[filter];
  }, [buckets, filter, runs]);

  return (
    <div className="main__inner main__inner--wide">
      <div className="page-head">
        <div>
          <h1>Runs</h1>
          <p>Every row carries its own chain, so you read progress as topology rather than a status word.</p>
        </div>
        <button className="btn btn--primary" onClick={onNew}>Start a run</button>
      </div>

      {error ? <p style={{ color: "var(--color-text-red)", marginBottom: "var(--spacing-4)" }}>Could not load runs: {error}</p> : null}

      <div className="filters">
        {(["all", "waiting", "running", "failed", "finished"] as const).map(f => (
          <button
            key={f}
            className="tab"
            data-active={filter === f ? "true" : undefined}
            onClick={() => setFilter(f)}
          >
            {FILTER_LABEL[f](counts)}
          </button>
        ))}
      </div>

      {!loading && runs.length === 0 ? (
        <div className="empty-hint">No runs yet. Start a pipeline from Start a run, or use sf run from the CLI.</div>
      ) : null}

      {visible.map(run => {
        const token = cssStatusToken(runDisplayStatus(run));
        return (
          <a
            key={run.run_id}
            className="rrow"
            data-s={token && token !== "running" ? token : undefined}
            href={`#/runs/${run.run_id}`}
            onClick={e => { e.preventDefault(); onOpen(run.run_id); }}
          >
            <span>
              <span className="rrow__task">{run.task_id ?? run.pipeline_id}</span>
              <span className="rrow__pipe" style={{ display: "block" }}>{run.pipeline_id} · {run.run_id.slice(0, 8)}</span>
            </span>
            <span>
              <MiniTrack stages={run.stages ?? []} label={miniTrackLabel(run)} />
            </span>
            <span className="rrow__right">
              <span className={`status${token && token !== "running" ? ` status--${token}` : ""}`}>
                <span className={`dot${token ? ` dot--${token}` : ""}`}></span> {relativeTime(run.updated_at ?? run.created_at)}
              </span>
            </span>
          </a>
        );
      })}

      {loading ? <p className="muted" style={{ padding: "var(--spacing-4)" }}>Loading runs…</p> : null}
    </div>
  );
}

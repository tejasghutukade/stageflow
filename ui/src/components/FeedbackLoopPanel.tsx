import type {
  FeedbackLoopHistory,
  FeedbackLoopRecord,
  FeedbackLoopState,
} from "../api";

export type FeedbackLoopPanelProps = {
  active?: FeedbackLoopRecord;
  history: FeedbackLoopHistory[];
};

function replayBudgetLine(loop: FeedbackLoopRecord): string {
  const current = loop.current_replay_number ?? 0;
  const max = loop.policy.max_replays;
  return `Replay ${current} of ${max}`;
}

function lastReplayTarget(history: FeedbackLoopHistory[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const replays = history[i]?.replays;
    if (!replays || replays.length === 0) continue;
    const last = replays[replays.length - 1]?.replay;
    if (last?.target_stage_id) return last.target_stage_id;
  }
  return null;
}

function loopRouteLine(
  loop: FeedbackLoopRecord,
  history: FeedbackLoopHistory[],
): string | null {
  const target =
    loop.deferred_send_back?.target ??
    lastReplayTarget(history) ??
    loop.policy.target ??
    null;
  if (!target) return null;
  return `${loop.source_stage_id} → ${target}`;
}

function loopStatusClass(state: FeedbackLoopState): string {
  switch (state) {
    case "waiting_for_human":
      return "status status--waiting";
    case "completed":
    case "continued":
      return "status status--succeeded";
    case "abandoned":
      return "status status--failed";
    case "active":
    default:
      return "status";
  }
}

export function FeedbackLoopPanel({ active, history }: FeedbackLoopPanelProps) {
  if (!active && history.length === 0) return null;

  const loop = active ?? history[history.length - 1]?.loop;
  const routeLine = loop ? loopRouteLine(loop, history) : null;
  const timelineReplays = history.flatMap((entry) => entry.replays);
  const supersededCount = history.reduce((count, entry) => {
    let n = entry.fork_generations.filter((g) => g.status === "superseded").length;
    for (const replay of entry.replays) {
      n += replay.fork_generations.filter((g) => g.status === "superseded").length;
    }
    return count + n;
  }, 0);

  return (
    <section className="feedback-loop-panel block">
      <div className="block__body">
        <div className="block__meta">
          <span className="block__pipeline">Feedback loop</span>
          {loop ? (
            <span className={loopStatusClass(loop.state)}>
              {loop.state.replaceAll("_", " ")}
            </span>
          ) : null}
        </div>
        {loop ? (
          <dl className="kv">
            <dt>Budget</dt>
            <dd>{replayBudgetLine(loop)}</dd>
            {routeLine ? (
              <>
                <dt>Route</dt>
                <dd>{routeLine}</dd>
              </>
            ) : null}
            <dt>Session</dt>
            <dd>{loop.policy.replay_session}</dd>
          </dl>
        ) : null}

        {timelineReplays.length > 0 ? (
          <div className="feedback-loop-panel__timeline">
            <div className="decide__label">Replay timeline</div>
            <ol className="feedback-loop-panel__list">
              {timelineReplays.map(({ replay, stage_passes }) => (
                <li key={replay.replay_id}>
                  <span>
                    #{replay.replay_number} {replay.source_stage_id} →{" "}
                    {replay.target_stage_id}
                  </span>
                  <span className="feedback-loop-panel__status">
                    {replay.status.replaceAll("_", " ")}
                    {stage_passes.length > 0
                      ? ` · ${stage_passes.length} stage pass${stage_passes.length === 1 ? "" : "es"}`
                      : ""}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {supersededCount > 0 ? (
          <p className="block__sub">
            {supersededCount} superseded fork generation
            {supersededCount === 1 ? "" : "s"} marked on the map.
          </p>
        ) : null}
      </div>
    </section>
  );
}

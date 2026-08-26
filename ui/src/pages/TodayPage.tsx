import { useEffect, useState, type ReactNode } from "react";
import {
  fetchRunArtifact,
  rerun,
  type RunSummary,
} from "../api";
import { useRunCatalog } from "../catalog/useRunCatalog";
import { bucketViews, capacityView } from "../catalog/views";
import { runLocatorSubtitle, runTaskLabel } from "../catalog/displayCatalogPath";
import {
  miniTrackLabel,
  relativeTime,
  stageIndexLabel,
} from "../catalogJoin";
import { TodayTriage } from "../components/TodayTriage";
import { isAcceptEligible } from "../stageAnswer/answerRules";
import { useOperatorAnswer } from "../stageAnswer/useOperatorAnswer";
import { trackSegmentToken, waitingOnYouTitle } from "../status/runStatus";

function attentionTitle(waitingCount: number): string {
  if (waitingCount === 0) return "Nothing needs you";
  if (waitingCount === 1) return "One thing needs you";
  return `${waitingCount} things need you`;
}

function waitingKindCopy(run: RunSummary): string {
  const stage = run.waiting_stage_id ?? "this stage";
  switch (run.waiting_kind) {
    case "confirm":
      return `Stage ${stage} paused its session to ask. Rejecting sends your note back to the same session.`;
    case "artifact_backed":
      return `Stage ${stage} asked an artifact_backed prompt. Reject revises in the same session.`;
    case "multi_question":
      return `Stage ${stage} asked a multi_question prompt. All answers go back in one reply.`;
    case "free_text":
      return `Stage ${stage} asked a free_text prompt.`;
    default:
      return `Stage ${stage} is waiting for input.`;
  }
}

function peekName(run: RunSummary): { icon: string; name: string } {
  const artifact = run.waiting_artifacts?.[0];
  if (artifact) {
    const name = artifact.split("/").pop() ?? artifact;
    return { icon: "◆", name };
  }
  return { icon: "?", name: run.waiting_kind ?? "waiting" };
}

function peekBody(run: RunSummary): string {
  const text = run.waiting_summary ?? "Waiting for input";
  if (text.length <= 180) return text;
  return `${text.slice(0, 180)}…`;
}

const PEEK_MAX_CHARS = 400;
const PEEK_MAX_LINES = 12;

function clipPeekText(text: string): string {
  const lines = text.split("\n").slice(0, PEEK_MAX_LINES);
  let clipped = lines.join("\n");
  if (clipped.length > PEEK_MAX_CHARS) {
    clipped = `${clipped.slice(0, PEEK_MAX_CHARS).trimEnd()}…`;
  }
  return clipped;
}

function peekExcerptNodes(text: string): ReactNode {
  const clipped = clipPeekText(text);
  const lines = clipped.split("\n");
  let heading: string | undefined;
  const paragraphs: string[] = [];
  for (const line of lines) {
    const match = line.match(/^#+\s+(.+)/);
    if (!heading && match?.[1]) {
      heading = match[1];
      continue;
    }
    if (line.trim()) paragraphs.push(line.replace(/^#+\s+/, ""));
  }
  return (
    <>
      {heading ? <strong>{heading}</strong> : null}
      {paragraphs.length > 0 ? (
        paragraphs.map((p, i) => <p key={i}>{p}</p>)
      ) : heading ? null : (
        <p>{clipped}</p>
      )}
    </>
  );
}

function PeekDoc({ run }: { run: RunSummary }) {
  const artifact = run.waiting_artifacts?.[0];
  const [excerpt, setExcerpt] = useState<ReactNode | null>(null);

  useEffect(() => {
    if (run.waiting_kind !== "artifact_backed" || !artifact) {
      setExcerpt(null);
      return;
    }
    let cancelled = false;
    void fetchRunArtifact(run.run_id, artifact)
      .then((text) => {
        if (!cancelled) setExcerpt(peekExcerptNodes(text));
      })
      .catch(() => {
        if (!cancelled) setExcerpt(null);
      });
    return () => {
      cancelled = true;
    };
  }, [run.run_id, run.waiting_kind, artifact]);

  if (run.waiting_kind === "multi_question" && run.waiting_questions?.length) {
    return (
      <span className="peek-doc">
        {run.waiting_questions.map((q, i) => (
          <p key={i}>{q}</p>
        ))}
      </span>
    );
  }

  return (
    <span className="peek-doc">
      {excerpt ?? <p>{peekBody(run)}</p>}
    </span>
  );
}

function heldMeta(run: RunSummary): string {
  const when = relativeTime(run.updated_at ?? run.created_at);
  const stage = stageIndexLabel(run.stages, run.waiting_stage_id);
  if (stage) return `held ${when} at ${stage}`;
  return `held ${when}`;
}

function currentStageName(run: RunSummary): string {
  const running = run.stages?.find((s) => s.status === "running");
  if (running) return running.id;
  if (run.waiting_stage_id) return run.waiting_stage_id;
  return "";
}

function WaitingCard({
  run,
  onOpen,
  onOpenArtifact,
}: {
  run: RunSummary;
  onOpen: (runId: string) => void;
  onOpenArtifact: (runId: string, path: string) => void;
}) {
  const kind = run.waiting_kind;
  const pending =
    run.waiting_prompt_id && kind
      ? { promptId: run.waiting_prompt_id, kind }
      : null;
  const { locked, error, submitIntent } = useOperatorAnswer(
    run.run_id,
    run.waiting_stage_id,
    pending,
  );
  const canAccept = isAcceptEligible({
    promptId: run.waiting_prompt_id,
    kind,
  });
  const artifact = run.waiting_artifacts?.[0];
  const peek = peekName(run);
  const questionCount = run.waiting_questions?.length ?? 0;

  function onPeek() {
    if (artifact) onOpenArtifact(run.run_id, artifact);
    else onOpen(run.run_id);
  }

  return (
    <article className="block">
      <div className="block__body">
        <div className="block__meta">
          <a className="block__pipeline" href={`#/pipelines/${run.pipeline_id}`}>{runLocatorSubtitle(run)}</a>
          <span className="status status--waiting">{heldMeta(run)}</span>
        </div>
        <p className="block__q">{run.waiting_summary ?? "Waiting for input"}</p>
        <p className="block__sub">{waitingKindCopy(run)}</p>
        {error ? <p style={{color:'var(--color-text-red)',fontSize:'var(--font-size-sm)'}}>Could not accept: {error}</p> : null}
        <div className="block__actions">
          {canAccept ? <button className="btn btn--accept" disabled={locked} onClick={() => void submitIntent({ type: "decision", decision: "accept" })}>Accept</button> : null}
          {(kind === "confirm" || kind === "artifact_backed") ? <button className="btn btn--reject" onClick={() => onOpen(run.run_id)}>Reject with note</button> : null}
          {kind === "multi_question" ? (
            <button className="btn btn--primary" onClick={() => onOpen(run.run_id)}>
              {questionCount > 0 ? `Answer ${questionCount} questions` : "Answer questions"}
            </button>
          ) : null}
          {kind === "free_text" ? <button className="btn btn--primary" onClick={() => onOpen(run.run_id)}>Answer</button> : null}
          {(kind === "artifact_backed" && artifact) ? <button className="btn" onClick={() => onOpenArtifact(run.run_id, artifact)}>Read {peek.name}</button> : null}
          <button className="btn btn--ghost" onClick={() => onOpen(run.run_id)}>Open run</button>
        </div>
      </div>
      <button className="block__peek" onClick={onPeek} aria-label={artifact ? `Open ${peek.name}` : "Open run"}>
        <span className="block__peek-name"><span aria-hidden="true">{peek.icon}</span> {peek.name}</span>
        <PeekDoc run={run} />
      </button>
    </article>
  );
}

export function TodayPage({
  onOpen,
  onOpenArtifact,
  onNew,
  onSeeRuns,
}: {
  onOpen: (runId: string) => void;
  onOpenArtifact: (runId: string, path: string) => void;
  onNew: () => void;
  onSeeRuns: () => void;
}) {
  const { snapshot, error: catalogError, loading } = useRunCatalog();
  const [error, setError] = useState<string | null>(null);
  const [rerunningId, setRerunningId] = useState<string | null>(null);

  const buckets = bucketViews(snapshot);
  const capacity = capacityView(snapshot);
  const displayError = error ?? catalogError;

  async function onRerun(runId: string) {
    setRerunningId(runId);
    try {
      const result = await rerun(runId);
      onOpen(result.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRerunningId(null);
    }
  }

  const empty =
    !loading &&
    buckets.waiting.length === 0 &&
    buckets.inFlight.length === 0 &&
    buckets.broken.length === 0 &&
    buckets.finished.length === 0;

  const finishedPreview = buckets.finished.slice(0, 3);

  return (
    <div className="main__inner">
      <div className="page-head">
        <div>
          <h1>{attentionTitle(buckets.waiting.length)}</h1>
          <p>{capacity.line}</p>
        </div>
        <a className="btn btn--primary" href="#/new" onClick={e => { e.preventDefault(); onNew(); }}>Start a run</a>
      </div>
      {displayError ? <p style={{color:'var(--color-text-red)'}}>Could not load runs: {displayError}</p> : null}
      {loading ? <p className="muted">Loading…</p> : null}
      {empty ? <div className="empty-hint">No runs yet. Start a pipeline to see triage zones fill in.</div> : null}
      {!loading && !empty ? (
        <TodayTriage
          waiting={{
            label: waitingOnYouTitle(),
            count: buckets.waiting.length,
            status: "waiting",
            children:
              buckets.waiting.length === 0 ? (
                <p className="muted" style={{fontSize:'var(--font-size-sm)'}}>Nothing waiting.</p>
              ) : (
                buckets.waiting.map((run) => (
                  <WaitingCard
                    key={run.run_id}
                    run={run}
                    onOpen={onOpen}
                    onOpenArtifact={onOpenArtifact}
                  />
                ))
              ),
          }}
          inFlight={{
            label: "In flight",
            count: buckets.inFlight.length,
            status: "running",
            children:
              buckets.inFlight.length === 0 ? (
                <p className="muted" style={{fontSize:'var(--font-size-sm)'}}>No runs in flight.</p>
              ) : (
                <div className="runs">
                  {buckets.inFlight.map((run) => (
                    <a key={run.run_id} className="run-row" href={`#/runs/${run.run_id}`} onClick={e => { e.preventDefault(); onOpen(run.run_id); }}>
                      <span className="run-row__id">
                        <span className="dot dot--running"></span>
                        <span className="run-row__name">{runTaskLabel(run)} <span>· {currentStageName(run)}</span></span>
                      </span>
                      <span>
                        <span className="track-mini" aria-hidden="true">
                          {run.stages.map((s) => {
                            const seg = trackSegmentToken(s.status);
                            return <i key={s.id} className="track-mini__seg" {...(seg ? {"data-s": seg} : {})}></i>;
                          })}
                        </span>
                        <span className="track-mini__label">{miniTrackLabel(run)}</span>
                      </span>
                      <span className="run-row__right">{relativeTime(run.updated_at ?? run.created_at)}</span>
                    </a>
                  ))}
                </div>
              ),
          }}
          broken={{
            label: "Broken",
            count: buckets.broken.length,
            status: "failed",
            children:
              buckets.broken.length === 0 ? (
                <p className="muted" style={{fontSize:'var(--font-size-sm)'}}>No failed runs.</p>
              ) : (
                buckets.broken.map((run) => (
                  <div key={run.run_id} className="fail-row">
                    <span className="dot dot--failed"></span>
                    <span className="fail-row__why">
                      <b>{runTaskLabel(run)}</b> · {runLocatorSubtitle(run)}
                      {run.failed_reason ? <span>{run.failed_reason}</span> : null}
                    </span>
                    <button className="btn btn--sm" onClick={e => { e.stopPropagation(); onOpen(run.run_id); }}>Open stage</button>
                    <button className="btn btn--sm" disabled={rerunningId === run.run_id} onClick={e => { e.stopPropagation(); void onRerun(run.run_id); }}>{rerunningId === run.run_id ? "Starting fresh…" : "Start fresh"}</button>
                  </div>
                ))
              ),
          }}
          finished={{
            label: "Finished",
            count: buckets.finished.length,
            status: "succeeded",
            children:
              buckets.finished.length === 0 ? (
                <p className="muted" style={{fontSize:'var(--font-size-sm)'}}>No finished runs yet.</p>
              ) : (
                <>
                  <div className="runs">
                    {finishedPreview.map((run) => (
                      <a key={run.run_id} className="run-row" href={`#/runs/${run.run_id}`} onClick={e => { e.preventDefault(); onOpen(run.run_id); }}>
                        <span className="run-row__id">
                          <span className="dot dot--succeeded"></span>
                          <span className="run-row__name">{runTaskLabel(run)} <span>· {runLocatorSubtitle(run)}</span></span>
                        </span>
                        <span className="mono muted">{run.stages.length} stages</span>
                        <span className="run-row__right">{relativeTime(run.updated_at ?? run.created_at)}</span>
                      </a>
                    ))}
                  </div>
                  <p style={{margin: 'var(--spacing-3) 0 0'}}>
                    <button className="btn btn--sm btn--ghost" onClick={onSeeRuns}>See every run →</button>
                  </p>
                </>
              ),
          }}
        />
      ) : null}
    </div>
  );
}

import type { StageGateKind, StageSnapshot } from "../api";
import { canAbandon, canRetry, isStageActionBusy } from "../stageAction";
import { StatusLabel } from "../StatusLabel";
import { AttemptCountBadge } from "./AttemptCountBadge";

export type TrackDetailRow = {
  stageId: string;
  label?: string;
  status: StageSnapshot["status"];
  attemptCount?: number;
  readinessLine?: string;
  gateKinds?: StageGateKind[];
  meta?: string;
  promptSummary?: string;
  isWaitingAttention: boolean;
};

export type TrackDetailListProps = {
  rows: TrackDetailRow[];
  selectedStageId?: string | null;
  onSelect?: (stageId: string) => void;
  retryingStageIds?: ReadonlySet<string>;
  onRetryStage?: (stageId: string) => void;
  abandoningStageId?: string | null;
  onAbandonStage?: (stageId: string) => void;
};

function gateLabel(kind: StageGateKind): string {
  switch (kind) {
    case "free_text":
      return "free text";
    case "confirm":
      return "confirm";
    case "multi_question":
      return "multi-question";
    case "artifact_backed":
      return "artifact";
  }
}

export function TrackDetailList({
  rows,
  selectedStageId,
  onSelect,
  retryingStageIds,
  onRetryStage,
  abandoningStageId = null,
  onAbandonStage,
}: TrackDetailListProps) {
  const retrying = retryingStageIds ?? new Set<string>();
  if (rows.length === 0) return null;

  return (
    <div className="track-detail-list" role="list" aria-label="Stage details">
      {rows.map((row) => (
        <div
          key={row.stageId}
          className="track-detail-row"
          role="button"
          tabIndex={0}
          data-selected={row.stageId === selectedStageId ? "true" : undefined}
          data-waiting={row.isWaitingAttention ? "true" : undefined}
          onClick={onSelect ? () => onSelect(row.stageId) : undefined}
          onKeyDown={
            onSelect
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(row.stageId);
                  }
                }
              : undefined
          }
        >
          <span className="track-detail-row__id">{row.label ?? row.stageId}</span>
          <StatusLabel status={row.status} />
          <AttemptCountBadge count={row.attemptCount} />
          {row.readinessLine ? (
            <span className="track-detail-row__readiness">{row.readinessLine}</span>
          ) : null}
          {row.meta ? (
            <span className="track-detail-row__meta">{row.meta}</span>
          ) : null}
          {row.promptSummary ? (
            <span className="track-detail-row__prompt">{row.promptSummary}</span>
          ) : null}
          {row.gateKinds && row.gateKinds.length > 0 ? (
            <span className="track-detail-row__gates">
              {row.gateKinds.map((kind) => (
                <span key={kind} className="track-detail-row__gate">
                  {gateLabel(kind)}
                </span>
              ))}
            </span>
          ) : null}
          {canRetry(row.status) && onRetryStage ? (
            <span className="track-detail-row__actions">
              <button
                type="button"
                className="btn btn--sm"
                disabled={isStageActionBusy(
                  { retryingStageIds: retrying, abandoningStageId },
                  row.stageId,
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  onRetryStage(row.stageId);
                }}
              >
                {retrying.has(row.stageId) ? "Retrying…" : "Retry stage"}
              </button>
            </span>
          ) : null}
          {canAbandon(row.status) && onAbandonStage ? (
            <span className="track-detail-row__actions">
              <button
                type="button"
                className="btn btn--sm btn--reject"
                disabled={isStageActionBusy(
                  { retryingStageIds: retrying, abandoningStageId },
                  row.stageId,
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  onAbandonStage(row.stageId);
                }}
              >
                {abandoningStageId === row.stageId ? "Abandoning…" : "Abandon"}
              </button>
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

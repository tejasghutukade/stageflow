import type { StageGateKind, StageReadiness, StageSnapshot } from "../api";
import { canAbandon, canRetry, isStageActionBusy } from "../stageAction";
import { StatusLabel } from "../StatusLabel";
import { useRedesign } from "../redesign/flag";
import { StatusPill } from "../redesign/StatusPill";
import {
  signalIcon,
  stageStatusPillLabel,
  statusSignalFromReadiness,
  statusSignalFromStageStatus,
} from "../redesign/statusSignal";
import { AttemptCountBadge } from "./AttemptCountBadge";

export type TrackDetailRow = {
  stageId: string;
  label?: string;
  status: StageSnapshot["status"];
  readiness?: StageReadiness;
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
  variant?: "legacy" | "redesign";
};

function formatListLastAt(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function listAttemptLabel(
  status: TrackDetailRow["status"],
  attemptCount?: number,
): string {
  if (status === "pending") return "—";
  if (attemptCount === undefined || attemptCount < 1) return "—";
  return `att ${attemptCount}`;
}

function redesignIconColor(signal: ReturnType<typeof statusSignalFromStageStatus>): string {
  if (signal === "ok") return "text-[#4cc38a]";
  if (signal === "fail") return "text-[#f2645a]";
  if (signal === "needs") return "text-[#f5b544]";
  if (signal === "running") return "text-[var(--sf-running)]";
  return "text-[var(--sf-text-3)]";
}

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
  variant,
}: TrackDetailListProps) {
  const redesign = useRedesign();
  const retrying = retryingStageIds ?? new Set<string>();
  if (rows.length === 0) return null;

  if (variant === "redesign") {
    return (
      <div className="flex min-w-0 flex-col" role="list" aria-label="Stage details">
        {rows.map((row, index) => {
          const selected = row.stageId === selectedStageId;
          const blocked = row.readiness === "blocked";
          const signal = blocked
            ? statusSignalFromReadiness("blocked")
            : row.isWaitingAttention
              ? statusSignalFromReadiness("waiting")
              : statusSignalFromStageStatus(row.status);
          const Icon = signalIcon(signal);
          const iconColor = redesignIconColor(signal);
          const muted =
            row.status === "pending" && !row.isWaitingAttention && !selected;
          const pillLabel = blocked
            ? "Blocked"
            : row.isWaitingAttention
              ? "Needs you"
              : stageStatusPillLabel(row.status);
          const pillClass = blocked
            ? "shrink-0 border border-dashed border-[var(--sf-text-2)] bg-[#8b8f981a]"
            : undefined;
          const isLast = index === rows.length - 1;

          return (
            <div
              key={row.stageId}
              className={`flex w-full items-center gap-3 px-3 py-0 text-left ${
                selected
                  ? "h-10 border-l-2 border-l-[var(--sf-needs)] bg-[#f5b54414]"
                  : `h-9${isLast ? "" : " border-b border-b-[#ffffff0f]"}`
              }`}
              role="button"
              tabIndex={0}
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
              <Icon className={`size-3.5 shrink-0 ${iconColor}`} aria-hidden="true" />
              <span
                className={`w-[100px] shrink-0 truncate font-sans text-[13px] leading-normal ${
                  muted ? "text-[var(--sf-text-3)]" : "text-[var(--sf-text-1)]"
                }${selected ? " font-medium" : ""}`}
              >
                {row.label ?? row.stageId}
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <StatusPill signal={signal} label={pillLabel} className={pillClass} />
                {row.readinessLine ? (
                  <span className="truncate font-sans text-[11px] text-[var(--sf-text-3)]">
                    {row.readinessLine}
                  </span>
                ) : null}
              </div>
              {row.promptSummary && row.isWaitingAttention ? (
                <span className="shrink-0 font-['Geist_Mono',monospace] text-[11px] text-[var(--sf-needs)]">
                  {row.promptSummary}
                </span>
              ) : null}
              <span className="shrink-0 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)]">
                {listAttemptLabel(row.status, row.attemptCount)}
              </span>
              <span
                className={`w-[72px] shrink-0 text-right font-['Geist_Mono',monospace] text-xs ${
                  row.isWaitingAttention ? "text-[var(--sf-needs)]" : "text-[var(--sf-text-3)]"
                }`}
              >
                {formatListLastAt(row.meta)}
              </span>
            </div>
          );
        })}
      </div>
    );
  }

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
          {redesign ? (
            <StatusPill
              signal={
                row.readiness === "blocked"
                  ? statusSignalFromReadiness("blocked")
                  : statusSignalFromStageStatus(row.status)
              }
              label={
                row.readiness === "blocked"
                  ? "Blocked"
                  : row.isWaitingAttention
                    ? "Needs you"
                    : stageStatusPillLabel(row.status)
              }
              className={
                row.readiness === "blocked"
                  ? "border border-dashed border-[var(--sf-text-2)] bg-transparent"
                  : undefined
              }
            />
          ) : (
            <StatusLabel status={row.status} />
          )}
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

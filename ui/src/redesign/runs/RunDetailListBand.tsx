import {
  TrackDetailList,
  type TrackDetailRow,
} from "../../components/TrackDetailList";

export type RunDetailListBandProps = {
  detailListRows: TrackDetailRow[];
  listHeader?: string;
  selectedStageId?: string | null;
  onSelect?: (stageId: string) => void;
  retryingStageIds?: ReadonlySet<string>;
  onRetryStage?: (stageId: string) => void;
  abandoningStageId?: string | null;
  onAbandonStage?: (stageId: string) => void;
};

export function RunDetailListBand({
  detailListRows,
  listHeader,
  selectedStageId,
  onSelect,
  retryingStageIds,
  onRetryStage,
  abandoningStageId,
  onAbandonStage,
}: RunDetailListBandProps) {
  if (detailListRows.length === 0) {
    return (
      <div className="flex w-full min-h-[200px] flex-col border-b border-b-[#ffffff12] px-6 pt-3 pb-2">
        <div className="flex items-center justify-between pb-2 pt-0">
          <span className="font-sans text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
            Track detail
          </span>
          {listHeader ? (
            <span className="font-sans text-xs text-[var(--sf-needs)]">{listHeader}</span>
          ) : null}
        </div>
        <p className="font-sans text-[13px] text-[var(--sf-text-2)]">No stages yet.</p>
      </div>
    );
  }

  return (
    <div className="flex w-full min-h-[200px] flex-col border-b border-b-[#ffffff12] px-6 pt-3 pb-2">
      <div className="flex items-center justify-between pb-2 pt-0">
        <span className="font-sans text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
          Track detail
        </span>
        {listHeader ? (
          <span className="font-sans text-xs text-[var(--sf-needs)]">{listHeader}</span>
        ) : null}
      </div>
      <div className="flex min-h-0 min-w-0 flex-col overflow-clip rounded-[10px] border border-[#ffffff12] bg-[var(--sf-raised)]">
        <TrackDetailList
          variant="redesign"
          rows={detailListRows}
          selectedStageId={selectedStageId}
          onSelect={onSelect}
          retryingStageIds={retryingStageIds}
          onRetryStage={onRetryStage}
          abandoningStageId={abandoningStageId}
          onAbandonStage={onAbandonStage}
        />
      </div>
    </div>
  );
}

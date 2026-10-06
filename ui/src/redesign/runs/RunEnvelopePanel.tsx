import type { RunDetail, StageEnvelopeView, StageSnapshot } from "../../api";
import { EnvelopeFields } from "../../components/EnvelopeFields";
import { stageCloneLabel } from "../../workspace/resolveRunWorkspace";

function envelopeStatusClass(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === "success" || normalized === "succeeded") {
    return "border-[#4cc38a4d] bg-[#4cc38a1a] text-[var(--sf-ok)]";
  }
  if (normalized === "failed" || normalized === "failure") {
    return "border-[#f2645a4d] bg-[#f2645a1a] text-[var(--sf-fail)]";
  }
  return "border-[#ffffff1a] bg-[var(--sf-raised)] text-[var(--sf-text-2)]";
}

export function RunEnvelopePanel({
  run,
  stage,
  envelope,
  fromStageId,
  onArtifactClick,
}: {
  run: RunDetail;
  stage: StageSnapshot;
  envelope: StageEnvelopeView | null;
  fromStageId?: string | null;
  onArtifactClick?: (path: string) => void;
}) {
  const label = stageCloneLabel(run, stage.stage_id);

  if (!envelope) {
    return (
      <p className="px-4 py-3 text-[13px] text-[var(--sf-text-2)]">
        {fromStageId
          ? `No handoff from ${stageCloneLabel(run, fromStageId)} for ${label} yet.`
          : `No inbound handoff for ${label} yet.`}
      </p>
    );
  }

  const title = fromStageId
    ? `${label} — handoff from ${stageCloneLabel(run, fromStageId)}`
    : `${label} — handoff record`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-[var(--sf-text-1)]">
          {title}
        </h3>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-medium ${envelopeStatusClass(envelope.status)}`}
        >
          {envelope.status}
        </span>
      </header>
      <EnvelopeFields
        variant="redesign"
        envelope={envelope}
        onArtifactClick={onArtifactClick}
      />
    </div>
  );
}

import type { RunDetail, StageSnapshot } from "../../api";
import { EnvelopeFields } from "../../components/EnvelopeFields";
import { stageCloneLabel } from "../../workspace/resolveRunWorkspace";

export function RunEnvelopePanel({
  run,
  stage,
  onArtifactClick,
}: {
  run: RunDetail;
  stage: StageSnapshot;
  onArtifactClick?: (path: string) => void;
}) {
  const label = stageCloneLabel(run, stage.stage_id);
  const envelope = stage.envelope;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3">
      <div className="mb-3 flex items-center gap-2">
        <span className="font-sans text-[11px] uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
          Envelope
        </span>
        <span className="text-[12px] text-[var(--sf-text-2)]">· {label}</span>
        {envelope ? (
          <span className="ml-auto rounded-sm bg-[var(--sf-raised)] px-2 py-0.5 text-[11px] text-[var(--sf-ok)]">
            Emitted
          </span>
        ) : (
          <span className="ml-auto rounded-sm bg-[var(--sf-raised)] px-2 py-0.5 text-[11px] text-[var(--sf-text-3)]">
            None
          </span>
        )}
      </div>
      {envelope ? (
        <EnvelopeFields envelope={envelope} onArtifactClick={onArtifactClick} />
      ) : (
        <p className="text-[13px] text-[var(--sf-text-2)]">
          No handoff envelope for this stage yet.
        </p>
      )}
    </div>
  );
}

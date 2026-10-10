import type { RunDetail, StageEnvelopeView, StageSnapshot } from "../../api";
import { EnvelopeFields } from "../../components/EnvelopeFields";
import { stageCloneLabel } from "../../workspace/resolveRunWorkspace";
import {
  inboundEnvelopeEmpty,
  inboundEnvelopeTitle,
  outboundEnvelopeEmpty,
  outboundEnvelopeTitle,
} from "./runEnvelopeCopy";

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

function EnvelopeRecordBlock({
  title,
  envelope,
  emptyMessage,
  onArtifactClick,
}: {
  title: string;
  envelope: StageEnvelopeView | null;
  emptyMessage: string;
  onArtifactClick?: (path: string) => void;
}) {
  if (!envelope) {
    return (
      <section className="flex flex-col gap-2">
        <h4 className="text-[11px] font-medium uppercase tracking-[0.88px] text-[var(--sf-text-3)]">
          {title}
        </h4>
        <p className="text-[13px] text-[var(--sf-text-3)]">{emptyMessage}</p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-[15px] font-semibold text-[var(--sf-text-1)]">
          {title}
        </h4>
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
    </section>
  );
}

export function RunEnvelopePanel({
  run,
  stage,
  inboundEnvelope,
  inboundFromStageId,
  outboundEnvelope,
  outboundToStageId,
  onArtifactClick,
}: {
  run: RunDetail;
  stage: StageSnapshot;
  inboundEnvelope: StageEnvelopeView | null;
  inboundFromStageId?: string | null;
  outboundEnvelope: StageEnvelopeView | null;
  outboundToStageId?: string | null;
  onArtifactClick?: (path: string) => void;
}) {
  const label = stageCloneLabel(run, stage.stage_id);

  const inboundTitle = inboundEnvelopeTitle(run, inboundFromStageId);
  const inboundEmpty = inboundEnvelopeEmpty(
    run,
    stage.stage_id,
    inboundFromStageId,
  );
  const outboundTitle = outboundEnvelopeTitle(run, outboundToStageId);
  const outboundEmpty = outboundEnvelopeEmpty(
    run,
    stage.stage_id,
    outboundToStageId,
  );

  const hasAny = Boolean(inboundEnvelope || outboundEnvelope);

  if (!hasAny && !inboundFromStageId && !outboundToStageId) {
    return (
      <p className="px-4 py-3 text-[13px] text-[var(--sf-text-2)]">
        No handoff envelopes for {label} yet.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 py-3">
      <EnvelopeRecordBlock
        title={inboundTitle}
        envelope={inboundEnvelope}
        emptyMessage={inboundEmpty}
        onArtifactClick={onArtifactClick}
      />
      <div className="h-px shrink-0 bg-[#ffffff12]" aria-hidden="true" />
      <EnvelopeRecordBlock
        title={outboundTitle}
        envelope={outboundEnvelope}
        emptyMessage={outboundEmpty}
        onArtifactClick={onArtifactClick}
      />
    </div>
  );
}

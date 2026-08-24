import { useEffect } from "react";
import type { StageEnvelopeView } from "../api";
import { EnvelopeFields } from "./EnvelopeFields";

export type EnvelopeDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
  fromStageId: string;
  toStageId?: string;
  envelope: StageEnvelopeView;
  onOpenFullRecord?: () => void;
  onArtifactClick?: (path: string) => void;
};

function envelopeStatusClass(status: string): string {
  if (status === "success") return "status status--succeeded";
  if (status === "failure") return "status status--failed";
  return "status";
}

function envelopeDotClass(status: string): string {
  if (status === "success") return "dot dot--succeeded";
  if (status === "failure") return "dot dot--failed";
  return "dot";
}

export function EnvelopeDrawer({
  isOpen,
  onClose,
  fromStageId,
  toStageId,
  envelope,
  onOpenFullRecord,
  onArtifactClick,
}: EnvelopeDrawerProps) {
  const subtitle = toStageId
    ? `${fromStageId} → ${toStageId}`
    : fromStageId;

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  return (
    <aside className="drawer" hidden={!isOpen}>
      <div className="drawer__head">
        <span className="eyebrow">Handoff envelope</span>
        <span className="mono muted">{subtitle}</span>
        <span className={envelopeStatusClass(envelope.status)}>
          <span className={envelopeDotClass(envelope.status)}></span>
          {" "}
          {envelope.status}
        </span>
        <span style={{ marginLeft: "auto" }}></span>
        {onOpenFullRecord ? (
          <button type="button" className="btn btn--sm" onClick={onOpenFullRecord}>
            Open full record
          </button>
        ) : null}
        <button type="button" className="btn btn--sm" onClick={onClose}>
          Close
        </button>
      </div>
      <EnvelopeFields
        envelope={envelope}
        onArtifactClick={onArtifactClick}
      />
    </aside>
  );
}

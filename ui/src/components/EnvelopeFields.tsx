import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import type { StageEnvelopeView } from "../api";

export type EnvelopeFieldsProps = {
  envelope: StageEnvelopeView;
  onArtifactClick?: (path: string) => void;
  payloadMaxHeight?: number;
};

export function EnvelopeFields({
  envelope,
  onArtifactClick,
  payloadMaxHeight = 280,
}: EnvelopeFieldsProps) {
  return (
    <div className="drawer__grid">
      <dl className="kv">
        <dt>Summary</dt>
        <dd>{envelope.summary}</dd>
        <dt>Artifacts</dt>
        <dd>
          {envelope.artifacts.length === 0 ? (
            <span className="muted">none</span>
          ) : (
            envelope.artifacts.map((path) => {
              const name = path.split("/").pop() ?? path;
              if (onArtifactClick) {
                return (
                  <button
                    key={path}
                    type="button"
                    className="chip chip--file"
                    onClick={() => onArtifactClick(path)}
                  >
                    ◆ {name}
                  </button>
                );
              }
              return (
                <span key={path} className="chip chip--file">
                  ◆ {name}
                </span>
              );
            })
          )}
        </dd>
        {envelope.notes ? (
          <>
            <dt>Notes</dt>
            <dd className="muted">{envelope.notes}</dd>
          </>
        ) : null}
      </dl>
      {envelope.payload ? (
        <div>
          <div className="eyebrow" style={{ marginBottom: "var(--spacing-2)" }}>
            payload
          </div>
          <CodeBlock
            code={JSON.stringify(envelope.payload, null, 2)}
            language="json"
            container="section"
            maxHeight={payloadMaxHeight}
            width="100%"
          />
        </div>
      ) : (
        <p className="muted">No payload.</p>
      )}
    </div>
  );
}

export function EnvelopeRecord({
  fromStageId,
  toStageId,
  envelope,
  onBackToTranscript,
  onArtifactClick,
}: {
  fromStageId: string;
  toStageId?: string;
  envelope: StageEnvelopeView;
  onBackToTranscript: () => void;
  onArtifactClick?: (path: string) => void;
}) {
  const subtitle = toStageId
    ? `${fromStageId} → ${toStageId}`
    : fromStageId;

  return (
    <div className="stream" style={{ height: "100%" }}>
      <header className="stream__head">
        <h3 className="stream__name">Handoff envelope</h3>
        <span className="mono muted">{subtitle}</span>
        <span style={{ marginLeft: "auto" }}></span>
        <button type="button" className="btn btn--sm" onClick={onBackToTranscript}>
          ← Transcript
        </button>
      </header>
      <div className="stream__body">
        <EnvelopeFields
          envelope={envelope}
          onArtifactClick={onArtifactClick}
          payloadMaxHeight={480}
        />
      </div>
    </div>
  );
}

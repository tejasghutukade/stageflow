import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import type { StageEnvelopeView } from "../api";

export type EnvelopeFieldsProps = {
  envelope: StageEnvelopeView;
  onArtifactClick?: (path: string) => void;
  payloadMaxHeight?: number;
  variant?: "legacy" | "redesign";
};

const FIELD_LABEL =
  "text-[11px] uppercase tracking-[0.88px] text-[#8b8f98]";

function EnvelopeFieldsRedesign({
  envelope,
  onArtifactClick,
  payloadMaxHeight = 280,
}: Omit<EnvelopeFieldsProps, "variant">) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <section className="flex flex-col gap-1 rounded-[10px] border border-[#ffffff12] bg-[#131418] p-3">
        <div className={FIELD_LABEL}>summary</div>
        <p className="text-[13px] leading-[1.45] text-[var(--sf-text-1)]">
          {envelope.summary}
        </p>
      </section>
      <section className="flex flex-col gap-2">
        <div className={FIELD_LABEL}>artifacts</div>
        {envelope.artifacts.length === 0 ? (
          <p className="text-[13px] text-[var(--sf-text-3)]">none</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {envelope.artifacts.map((path) => {
              const name = path.split("/").pop() ?? path;
              const chipClass =
                "rounded-md border border-[#ffffff12] bg-[#1a1c21] px-2 py-1 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-1)]";
              if (onArtifactClick) {
                return (
                  <button
                    key={path}
                    type="button"
                    className={`${chipClass} hover:border-[#ffffff28]`}
                    onClick={() => onArtifactClick(path)}
                  >
                    {name}
                  </button>
                );
              }
              return (
                <span key={path} className={chipClass}>
                  {name}
                </span>
              );
            })}
          </div>
        )}
      </section>
      {envelope.notes ? (
        <section className="flex flex-col gap-1">
          <div className={FIELD_LABEL}>notes</div>
          <p className="text-[13px] leading-normal text-[#a7aab2]">
            {envelope.notes}
          </p>
        </section>
      ) : null}
      {envelope.payload ? (
        <section
          className="flex min-h-[120px] flex-col gap-1"
          style={{ maxHeight: payloadMaxHeight }}
        >
          <div className={FIELD_LABEL}>payload</div>
          <pre className="min-h-0 flex-1 overflow-auto rounded-lg border border-[#ffffff12] bg-[#0c0d0f] p-3 font-['Geist_Mono',monospace] text-xs leading-normal text-[#a7aab2]">
            {JSON.stringify(envelope.payload, null, 2)}
          </pre>
        </section>
      ) : (
        <p className="text-[13px] text-[var(--sf-text-3)]">No payload.</p>
      )}
    </div>
  );
}

export function EnvelopeFields({
  envelope,
  onArtifactClick,
  payloadMaxHeight = 280,
  variant = "legacy",
}: EnvelopeFieldsProps) {
  if (variant === "redesign") {
    return (
      <EnvelopeFieldsRedesign
        envelope={envelope}
        onArtifactClick={onArtifactClick}
        payloadMaxHeight={payloadMaxHeight}
      />
    );
  }

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

export function formatEnvelopeSubtitle(
  fromStageId: string,
  toStageId: string | undefined,
  labelFor?: (stageId: string) => string,
): string {
  const label = (id: string) => labelFor?.(id) ?? id;
  return toStageId
    ? `${label(fromStageId)} → ${label(toStageId)}`
    : label(fromStageId);
}

export function EnvelopeRecord({
  fromStageId,
  toStageId,
  envelope,
  onBackToTranscript,
  onHide,
  onArtifactClick,
  stageLabel,
}: {
  fromStageId: string;
  toStageId?: string;
  envelope: StageEnvelopeView;
  onBackToTranscript: () => void;
  onHide?: () => void;
  onArtifactClick?: (path: string) => void;
  stageLabel?: (stageId: string) => string;
}) {
  const subtitle = formatEnvelopeSubtitle(fromStageId, toStageId, stageLabel);

  return (
    <div className="stream" style={{ height: "100%" }}>
      <header className="stream__head">
        <h3 className="stream__name">Handoff envelope</h3>
        <span className="mono muted">{subtitle}</span>
        <span className="topbar__spacer"></span>
        <div className="stream__head-trail">
          <button type="button" className="btn btn--sm" onClick={onBackToTranscript}>
            ← Transcript
          </button>
          {onHide ? (
            <button type="button" className="btn btn--sm" onClick={onHide}>
              Hide workspace
            </button>
          ) : null}
        </div>
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

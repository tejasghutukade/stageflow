import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import type { StageEnvelopeView } from "../api";

export type EnvelopeFieldsProps = {
  envelope: StageEnvelopeView;
  onArtifactClick?: (path: string) => void;
  /** Host-disk artifact paths for this stage (`stage.artifacts`). When set, claims not on disk are muted and labeled. */
  diskArtifacts?: readonly string[];
  payloadMaxHeight?: number;
  variant?: "legacy" | "redesign";
};

const FIELD_LABEL =
  "text-[11px] uppercase tracking-[0.88px] text-[#8b8f98]";

export function artifactFileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() || normalized;
}

/**
 * Resolve an envelope artifact claim against on-disk paths.
 * Prefer exact run-relative match; fall back to a unique basename match when forms diverge.
 */
export function resolveDiskArtifactPath(
  claim: string,
  diskPaths: readonly string[],
): string | null {
  const normalizedClaim = claim.replace(/\\/g, "/");
  for (const path of diskPaths) {
    if (path === claim || path.replace(/\\/g, "/") === normalizedClaim) {
      return path;
    }
  }
  const claimBase = artifactFileName(normalizedClaim);
  const byBase = diskPaths.filter(
    (path) => artifactFileName(path) === claimBase,
  );
  return byBase.length === 1 ? (byBase[0] ?? null) : null;
}

export function isArtifactClaimOnDisk(
  claim: string,
  diskPaths: readonly string[],
): boolean {
  return resolveDiskArtifactPath(claim, diskPaths) != null;
}

function ArtifactChip({
  path,
  onDisk,
  onArtifactClick,
  variant,
}: {
  path: string;
  onDisk: boolean;
  onArtifactClick?: (path: string) => void;
  variant: "legacy" | "redesign";
}) {
  const name = artifactFileName(path);
  const label = onDisk ? name : `${name} · missing`;

  if (variant === "redesign") {
    const chipClass = onDisk
      ? "rounded-md border border-[#ffffff12] bg-[#1a1c21] px-2 py-1 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-1)]"
      : "rounded-md border border-[#ffffff12] bg-[#1a1c21] px-2 py-1 font-['Geist_Mono',monospace] text-xs text-[var(--sf-text-3)] opacity-60";
    if (onArtifactClick) {
      return (
        <button
          type="button"
          className={
            onDisk ? `${chipClass} hover:border-[#ffffff28]` : chipClass
          }
          aria-disabled={!onDisk}
          title={onDisk ? path : `${path} (not on disk)`}
          onClick={() => onArtifactClick(path)}
        >
          {label}
        </button>
      );
    }
    return (
      <span
        className={chipClass}
        title={onDisk ? path : `${path} (not on disk)`}
      >
        {label}
      </span>
    );
  }

  if (onArtifactClick) {
    return (
      <button
        type="button"
        className={onDisk ? "chip chip--file" : "chip chip--file muted"}
        aria-disabled={!onDisk}
        title={onDisk ? path : `${path} (not on disk)`}
        onClick={() => onArtifactClick(path)}
      >
        ◆ {label}
      </button>
    );
  }
  return (
    <span
      className={onDisk ? "chip chip--file" : "chip chip--file muted"}
      title={onDisk ? path : `${path} (not on disk)`}
    >
      ◆ {label}
    </span>
  );
}

function EnvelopeFieldsRedesign({
  envelope,
  onArtifactClick,
  diskArtifacts,
  payloadMaxHeight = 280,
}: Omit<EnvelopeFieldsProps, "variant">) {
  const checkDisk = diskArtifacts !== undefined;
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
            {envelope.artifacts.map((path) => (
              <ArtifactChip
                key={path}
                path={path}
                onDisk={
                  !checkDisk ||
                  isArtifactClaimOnDisk(path, diskArtifacts ?? [])
                }
                onArtifactClick={onArtifactClick}
                variant="redesign"
              />
            ))}
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
  diskArtifacts,
  payloadMaxHeight = 280,
  variant = "legacy",
}: EnvelopeFieldsProps) {
  if (variant === "redesign") {
    return (
      <EnvelopeFieldsRedesign
        envelope={envelope}
        onArtifactClick={onArtifactClick}
        diskArtifacts={diskArtifacts}
        payloadMaxHeight={payloadMaxHeight}
      />
    );
  }

  const checkDisk = diskArtifacts !== undefined;

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
            envelope.artifacts.map((path) => (
              <ArtifactChip
                key={path}
                path={path}
                onDisk={
                  !checkDisk ||
                  isArtifactClaimOnDisk(path, diskArtifacts ?? [])
                }
                onArtifactClick={onArtifactClick}
                variant="legacy"
              />
            ))
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
  diskArtifacts,
  stageLabel,
}: {
  fromStageId: string;
  toStageId?: string;
  envelope: StageEnvelopeView;
  onBackToTranscript: () => void;
  onHide?: () => void;
  onArtifactClick?: (path: string) => void;
  diskArtifacts?: readonly string[];
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
          diskArtifacts={diskArtifacts}
          payloadMaxHeight={480}
        />
      </div>
    </div>
  );
}

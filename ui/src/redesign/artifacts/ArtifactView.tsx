import { lazy, Suspense, useState, type ReactNode } from "react";
import { parseArtifactShowKey } from "../../../../src/cli/artifactListFormat.ts";
import type { ArtifactDetailMeta } from "./artifactDetailModel";
import { LIVE_VERSION_SNAPSHOT_NOTE, viewingVersionBanner } from "./artifactDetailModel";
import { ExplanationCard, StaticArtifactBody } from "./renderers/StaticPreview";
import type { StaticPreview } from "./renderers/previewModel";
import type { LivePreviewInput } from "./livePreview";
import type { LiveHtmlFrameProps } from "./liveHtml/LiveHtmlFrame";
import { useArtifactViewModel, type ArtifactViewIdentity, type ArtifactViewReady } from "./artifactViewModel";

const LiveArtifactRenderer = lazy(() =>
  import("./live/LiveArtifactRenderer").then((mod) => ({ default: mod.LiveArtifactRenderer })),
);

const LiveHtmlFrame = lazy(() =>
  import("./liveHtml/LiveHtmlFrame").then((mod) => ({ default: mod.LiveHtmlFrame })),
);

export const ARTIFACT_VIEW_INLINE_COLLAPSED_MAX_PX = 420;

export type ArtifactViewDensity = "page" | "inline";

export type ArtifactViewContentProps = {
  density: ArtifactViewDensity;
  meta: ArtifactDetailMeta;
  preview: StaticPreview | null;
  imageUrl?: string | null;
  program?: string | null;
  livePreview?: LivePreviewInput | null;
  liveHtml?: LiveHtmlFrameProps | null;
  historicalSnapshots?: boolean;
  viewing?: { version: number; latest: number } | null;
  onViewLatest?: () => void;
  showSourceDetails?: boolean;
};

export function ArtifactViewContent({
  density,
  meta,
  preview,
  imageUrl,
  program,
  livePreview,
  liveHtml,
  historicalSnapshots,
  viewing,
  onViewLatest,
  showSourceDetails = true,
}: ArtifactViewContentProps) {
  const showLiveProgram = meta.kind === "live.declarative" && (preview === null || preview.mode !== "unavailable");
  const showLiveHtml = meta.kind === "live.html" && (preview === null || preview.mode !== "unavailable");
  const [expanded, setExpanded] = useState(false);
  const inlineShell =
    density === "inline"
      ? {
          className: `min-w-0 overflow-hidden rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] ${
            expanded ? "" : "max-h-[var(--sf-artifact-inline-max)]"
          }`,
          style: expanded
            ? undefined
            : ({ "--sf-artifact-inline-max": `${ARTIFACT_VIEW_INLINE_COLLAPSED_MAX_PX}px` } as React.CSSProperties),
        }
      : { className: "min-w-0", style: undefined };

  let body: ReactNode;
  if (preview?.mode === "unavailable") {
    body = <StaticArtifactBody preview={preview} imageUrl={imageUrl} imageAlt={meta.title} />;
  } else if (showLiveHtml) {
    body = (
      <div>
        {historicalSnapshots ? (
          <p className="mb-3 text-[13px] text-[var(--sf-text-2)]">{LIVE_VERSION_SNAPSHOT_NOTE}</p>
        ) : null}
        {liveHtml ? (
          <Suspense fallback={<p className="text-[13px] text-[var(--sf-text-3)]">Loading live HTML…</p>}>
            <LiveHtmlFrame {...liveHtml} />
          </Suspense>
        ) : (
          <p className="text-[13px] text-[var(--sf-text-3)]">Loading live HTML…</p>
        )}
        {showSourceDetails ? (
          <details className="mt-4">
            <summary className="cursor-pointer text-[13px] text-[var(--sf-text-2)]">HTML source</summary>
            <pre className="sf-mono mt-2 whitespace-pre-wrap text-[13px] text-[var(--sf-text-1)]">{liveHtml?.html ?? ""}</pre>
          </details>
        ) : null}
      </div>
    );
  } else if (showLiveProgram) {
    body = (
      <div>
        {livePreview ? (
          <Suspense fallback={<p className="text-[13px] text-[var(--sf-text-3)]">Loading live preview…</p>}>
            <LiveArtifactRenderer {...livePreview} />
          </Suspense>
        ) : (
          <p className="text-[13px] text-[var(--sf-text-3)]">Loading live preview…</p>
        )}
        {showSourceDetails ? (
          <details className="mt-4">
            <summary className="cursor-pointer text-[13px] text-[var(--sf-text-2)]">Program source</summary>
            <pre className="sf-mono mt-2 whitespace-pre-wrap text-[13px] text-[var(--sf-text-1)]">{program ?? ""}</pre>
          </details>
        ) : null}
      </div>
    );
  } else if (preview) {
    body = <StaticArtifactBody preview={preview} imageUrl={imageUrl} imageAlt={meta.title} />;
  } else {
    body = <p className="text-[13px] text-[var(--sf-text-3)]">Loading artifact…</p>;
  }

  return (
    <div className={inlineShell.className} style={inlineShell.style}>
      <div className={`min-w-0 ${density === "inline" ? "p-3" : ""}`}>
        {viewing && density === "page" ? (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)] px-3 py-2 text-[13px] text-[var(--sf-text-1)]">
            <span>{viewingVersionBanner(viewing.version, viewing.latest)}</span>
            <button
              type="button"
              className="underline decoration-[var(--sf-hairline)]"
              onClick={onViewLatest}
              disabled={!onViewLatest}
            >
              View latest
            </button>
          </div>
        ) : null}
        {body}
        {density === "inline" ? (
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              className="text-[12px] text-[var(--sf-text-2)] underline decoration-[var(--sf-hairline)]"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function readyContent(model: ArtifactViewReady, density: ArtifactViewDensity, onViewLatest?: () => void) {
  return (
    <ArtifactViewContent
      density={density}
      meta={model.meta}
      preview={model.preview}
      imageUrl={model.imageUrl}
      program={model.program}
      livePreview={model.livePreview}
      liveHtml={model.liveHtml}
      historicalSnapshots={model.historicalSnapshots}
      viewing={density === "page" ? model.viewing : null}
      onViewLatest={onViewLatest}
      showSourceDetails={density === "page"}
    />
  );
}

export function artifactViewIdentityFromKey(
  key: string,
  projectRoot?: string,
  version?: number,
): ArtifactViewIdentity | undefined {
  const parts = parseArtifactShowKey(key);
  if (!parts) return undefined;
  return { ownerKey: parts.ownerKey, id: parts.id, projectRoot, version };
}

function ArtifactViewLoaded({
  artifactKey,
  identity,
  density,
  onOpen,
}: {
  artifactKey: string;
  identity: ArtifactViewIdentity;
  density: ArtifactViewDensity;
  onOpen?: (href: string) => void;
}) {
  const model = useArtifactViewModel(identity);
  if (model.phase === "loading") {
    return <p className="text-[13px] text-[var(--sf-text-3)]">Loading artifact…</p>;
  }
  if (model.phase === "error") {
    if (density === "inline") {
      return (
        <ExplanationCard
          testId="artifact-unavailable"
          title="This artifact is unavailable"
          body="It was deleted or it has expired."
        />
      );
    }
    return (
      <p className="text-[13px] text-[var(--sf-fail)]" role="alert">
        {model.message}
      </p>
    );
  }
  return readyContent(
    model,
    density,
    onOpen && density === "page" && model.viewing ? () => onOpen(artifactKey) : undefined,
  );
}

export function ArtifactView({
  artifactKey,
  version,
  projectRoot,
  density,
  onOpen,
}: {
  artifactKey: string;
  version?: number;
  projectRoot?: string;
  density: ArtifactViewDensity;
  onOpen?: (href: string) => void;
}) {
  const identity = artifactViewIdentityFromKey(artifactKey, projectRoot, version);
  if (!identity) {
    return (
      <p className="text-[13px] text-[var(--sf-fail)]" role="alert">
        Invalid artifact key
      </p>
    );
  }
  return <ArtifactViewLoaded artifactKey={artifactKey} identity={identity} density={density} onOpen={onOpen} />;
}

export function artifactViewContentFromReady(model: ArtifactViewReady, density: ArtifactViewDensity): ArtifactViewContentProps {
  return {
    density,
    meta: model.meta,
    preview: model.preview,
    imageUrl: model.imageUrl,
    program: model.program,
    livePreview: model.livePreview,
    liveHtml: model.liveHtml,
    historicalSnapshots: model.historicalSnapshots,
    viewing: model.viewing,
    showSourceDetails: density === "page",
  };
}
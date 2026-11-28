import { useState } from "react";
import { parseArtifactShowKey } from "../../../../src/artifacts/showKey.ts";
import type { ArtifactLiveAction } from "../../api/artifacts";
import { liveQueryFromChat, postChatAction, type ChatActionTarget } from "../../chat/parts/chatActions";
import { renderArtifactFormat } from "../../chat/parts/formats";
import type { ArtifactDetailMeta } from "./artifactDetailModel";
import { viewingVersionBanner } from "./artifactDetailModel";
import { ExplanationCard, StaticArtifactBody } from "./renderers/StaticPreview";
import type { StaticPreview } from "./renderers/previewModel";
import type { LivePreviewInput } from "./livePreview";
import type { LiveHtmlFrameProps } from "./liveHtml/LiveHtmlFrame";
import { useArtifactViewModel, type ArtifactViewIdentity, type ArtifactViewReady } from "./artifactViewModel";

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
  actions?: ArtifactLiveAction[];
  onAction?: (action: ArtifactLiveAction) => void;
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
  actions,
  onAction,
}: ArtifactViewContentProps) {
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

  const body =
    preview?.mode === "unavailable" ? (
      <StaticArtifactBody preview={preview} imageUrl={imageUrl} imageAlt={meta.title} />
    ) : (
      renderArtifactFormat(meta.kind, {
        title: meta.title,
        preview,
        imageUrl,
        program,
        livePreview,
        liveHtml,
        historicalSnapshots,
        showSourceDetails,
      })
    );

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
        {density === "inline" && onAction && actions && actions.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                className="rounded-md border border-[var(--sf-hairline)] bg-[var(--sf-raised)] px-2.5 py-1 text-[12px] text-[var(--sf-text-1)]"
                onClick={() => onAction(action)}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
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

function readyContent(
  model: ArtifactViewReady,
  density: ArtifactViewDensity,
  onViewLatest?: () => void,
  chat?: { target: ChatActionTarget; artifactKey: string; version?: number },
) {
  const livePreview =
    model.livePreview && chat
      ? { ...model.livePreview, query: liveQueryFromChat(chat.target, chat.artifactKey, chat.version) }
      : model.livePreview;
  return (
    <ArtifactViewContent
      density={density}
      meta={model.meta}
      preview={model.preview}
      imageUrl={model.imageUrl}
      program={model.program}
      livePreview={livePreview}
      liveHtml={model.liveHtml}
      historicalSnapshots={model.historicalSnapshots}
      viewing={density === "page" ? model.viewing : null}
      onViewLatest={onViewLatest}
      showSourceDetails={density === "page"}
      actions={density === "inline" ? model.live?.actions : undefined}
      onAction={
        chat && density === "inline"
          ? (action) => {
              void postChatAction(chat.target, {
                key: chat.artifactKey,
                ...(chat.version !== undefined ? { version: chat.version } : {}),
                kind: action.type,
                action: action.id,
              });
            }
          : undefined
      }
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
  chat,
}: {
  artifactKey: string;
  identity: ArtifactViewIdentity;
  density: ArtifactViewDensity;
  onOpen?: (href: string) => void;
  chat?: ChatActionTarget;
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
    chat && density === "inline" ? { target: chat, artifactKey, version: identity.version } : undefined,
  );
}

export function ArtifactView({
  artifactKey,
  version,
  projectRoot,
  density,
  onOpen,
  chat,
}: {
  artifactKey: string;
  version?: number;
  projectRoot?: string;
  density: ArtifactViewDensity;
  onOpen?: (href: string) => void;
  chat?: ChatActionTarget;
}) {
  const identity = artifactViewIdentityFromKey(artifactKey, projectRoot, version);
  if (!identity) {
    return (
      <p className="text-[13px] text-[var(--sf-fail)]" role="alert">
        Invalid artifact key
      </p>
    );
  }
  return <ArtifactViewLoaded artifactKey={artifactKey} identity={identity} density={density} onOpen={onOpen} chat={chat} />;
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
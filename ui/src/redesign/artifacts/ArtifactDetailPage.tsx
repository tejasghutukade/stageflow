import { useEffect, useState, type ReactNode } from "react";
import {
  ArtifactRequestError,
  fetchArtifact,
  fetchArtifactContent,
  type ArtifactContentPayload,
  type ArtifactRecord,
} from "../../api/artifacts";
import { artifactsPath, navigate } from "../../routes";
import { Inspector } from "../shell/Inspector";
import { PageHeader } from "../shell/PageHeader";
import { artifactDetailMeta, type ArtifactDetailMeta } from "./artifactDetailModel";
import { previewFromContent, type StaticPreview } from "./renderers/previewModel";
import { StaticArtifactBody } from "./renderers/StaticPreview";

function MetaLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-[var(--sf-hairline)] py-2">
      <div className="text-[11px] uppercase tracking-wide text-[var(--sf-text-3)]">{label}</div>
      <div className="break-all text-[13px] text-[var(--sf-text-1)]">{children}</div>
    </div>
  );
}

function LinkButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="text-left underline decoration-[var(--sf-hairline)]" onClick={onClick}>
      {label}
    </button>
  );
}

export function ArtifactDetailView({
  meta,
  preview,
  imageUrl,
  onBack,
  onOpenRun,
  onOpenStage,
}: {
  meta: ArtifactDetailMeta;
  preview: StaticPreview | null;
  imageUrl?: string | null;
  onBack: () => void;
  onOpenRun?: () => void;
  onOpenStage?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <PageHeader
        title={meta.title}
        crumbs={[{ label: "Artifacts", onClick: onBack }]}
      />
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto px-5 py-4">
          {preview ? (
            <StaticArtifactBody preview={preview} imageUrl={imageUrl} imageAlt={meta.title} />
          ) : (
            <p className="text-[13px] text-[var(--sf-text-3)]">Loading artifact…</p>
          )}
        </main>
        <Inspector title="Details">
          <dl>
            <MetaLine label="Title">{meta.title}</MetaLine>
            <MetaLine label="Kind">
              <span className="sf-pill">
                <span className="sf-pill__label">{meta.kindLabel}</span>
              </span>
            </MetaLine>
            <MetaLine label="Owner">{meta.ownerLabel}</MetaLine>
            <MetaLine label="Size">{meta.sizeLabel}</MetaLine>
            <MetaLine label="Content type">{meta.contentType}</MetaLine>
            <MetaLine label="Created">{meta.createdLabel}</MetaLine>
            <MetaLine label="Updated">{meta.updatedLabel}</MetaLine>
            <MetaLine label="Content hash">{meta.hashLabel}</MetaLine>
            <MetaLine label="Run">
              {meta.runId && meta.runPath && onOpenRun ? (
                <LinkButton label={meta.runId} onClick={onOpenRun} />
              ) : (
                "—"
              )}
            </MetaLine>
            <MetaLine label="Stage">
              {meta.stageId && meta.stagePath && onOpenStage ? (
                <LinkButton label={meta.stageId} onClick={onOpenStage} />
              ) : (
                "—"
              )}
            </MetaLine>
          </dl>
        </Inspector>
      </div>
    </div>
  );
}

function payloadPreview(
  record: ArtifactRecord,
  payload: ArtifactContentPayload | null,
  error: ArtifactRequestError | null,
): { preview: StaticPreview; hash: string | null; imageUrl: string | null } {
  if (record.status === "expired") {
    return {
      preview: previewFromContent({ record, text: null, binary: false }),
      hash: record.content_hash ?? null,
      imageUrl: null,
    };
  }
  if (error) {
    return {
      preview: previewFromContent({
        record,
        text: null,
        binary: false,
        contentError: { code: error.code, message: error.message },
      }),
      hash: record.content_hash ?? null,
      imageUrl: null,
    };
  }
  if (!payload) {
    return {
      preview: previewFromContent({ record, text: null, binary: record.kind !== "static.image" }),
      hash: record.content_hash ?? null,
      imageUrl: null,
    };
  }
  if (payload.kind === "image") {
    return {
      preview: previewFromContent({ record, text: null, binary: false }),
      hash: payload.contentHash ?? record.content_hash ?? null,
      imageUrl: payload.objectUrl,
    };
  }
  if (payload.kind === "binary") {
    return {
      preview: previewFromContent({ record, text: null, binary: true }),
      hash: payload.contentHash ?? record.content_hash ?? null,
      imageUrl: null,
    };
  }
  return {
    preview: previewFromContent({ record, text: payload.text, binary: false }),
    hash: payload.contentHash ?? record.content_hash ?? null,
    imageUrl: null,
  };
}

export function ArtifactDetailPage({
  ownerKey,
  id,
  projectRoot,
}: {
  ownerKey: string;
  id: string;
  projectRoot?: string;
}) {
  const [record, setRecord] = useState<ArtifactRecord | null>(null);
  const [payload, setPayload] = useState<ArtifactContentPayload | null>(null);
  const [contentError, setContentError] = useState<ArtifactRequestError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let imageUrl: string | null = null;
    setLoading(true);
    setError(null);
    setRecord(null);
    setPayload(null);
    setContentError(null);
    void (async () => {
      try {
        const next = await fetchArtifact(ownerKey, id, projectRoot);
        if (cancelled) return;
        setRecord(next);
        if (next.status === "expired") {
          setLoading(false);
          return;
        }
        try {
          const body = await fetchArtifactContent(ownerKey, id, projectRoot);
          if (cancelled) {
            if (body.kind === "image") URL.revokeObjectURL(body.objectUrl);
            return;
          }
          if (body.kind === "image") imageUrl = body.objectUrl;
          setPayload(body);
        } catch (err) {
          if (cancelled) return;
          if (err instanceof ArtifactRequestError) setContentError(err);
          else setError(err instanceof Error ? err.message : String(err));
        }
        setLoading(false);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [ownerKey, id, projectRoot]);

  if (error && !record) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[var(--sf-ground)]">
        <PageHeader title="Artifact" crumbs={[{ label: "Artifacts", onClick: () => navigate(artifactsPath()) }]} />
        <p className="px-5 py-4 text-[13px] text-[var(--sf-fail)]">{error}</p>
      </div>
    );
  }
  if (loading || !record) {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[var(--sf-ground)]">
        <PageHeader title="Artifact" crumbs={[{ label: "Artifacts", onClick: () => navigate(artifactsPath()) }]} />
        <p className="px-5 py-4 text-[13px] text-[var(--sf-text-3)]">Loading artifact…</p>
      </div>
    );
  }
  const view = payloadPreview(record, payload, contentError);
  const meta = artifactDetailMeta(record, view.hash);
  return (
    <ArtifactDetailView
      meta={meta}
      preview={loading ? null : view.preview}
      imageUrl={view.imageUrl}
      onBack={() => navigate(artifactsPath())}
      onOpenRun={meta.runPath ? () => navigate(meta.runPath!) : undefined}
      onOpenStage={meta.stagePath ? () => navigate(meta.stagePath!) : undefined}
    />
  );
}

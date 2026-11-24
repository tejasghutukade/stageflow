import { useEffect, useState, type ReactNode } from "react";
import {
  ArtifactRequestError,
  deleteArtifact,
  fetchArtifact,
  fetchArtifactContent,
  fetchArtifactVersions,
  type ArtifactContentPayload,
  type ArtifactRecord,
  type ArtifactVersionRecord,
} from "../../api/artifacts";
import { artifactDetailPath, artifactsPath, navigate } from "../../routes";
import { MODAL_SCRIM_PT, OVERLAY_SCRIM_CLASS } from "../overlay/overlayScrimClasses";
import { Inspector } from "../shell/Inspector";
import { PageHeader } from "../shell/PageHeader";
import {
  artifactDetailMeta,
  artifactVersionRows,
  deleteArtifactConfirm,
  recordForViewedVersion,
  viewingVersionBanner,
  type ArtifactDetailMeta,
  type ArtifactVersionRowModel,
} from "./artifactDetailModel";
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

function VersionsSection({
  versions,
  onOpenVersion,
}: {
  versions: ArtifactVersionRowModel[];
  onOpenVersion?: (version: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-[var(--sf-hairline)] py-2">
      <div className="text-[11px] uppercase tracking-wide text-[var(--sf-text-3)]">Versions</div>
      <ul className="flex flex-col gap-1">
        {versions.map((row) => (
          <li key={row.version}>
            <button
              type="button"
              className="w-full text-left text-[13px] text-[var(--sf-text-1)]"
              onClick={() => onOpenVersion?.(row.version)}
            >
              <span className="sf-mono">v{row.version}</span>
              {row.current ? " Current" : ""}
              {row.pinned ? " Pinned" : ""}
              <span className="text-[var(--sf-text-3)]">
                {" "}
                {row.createdLabel} · {row.sizeLabel} · {row.hashLabel}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeleteArtifactDialog({
  title,
  body,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} className={`${OVERLAY_SCRIM_CLASS} ${MODAL_SCRIM_PT}`}>
      <div className="w-[460px] rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-panel)] p-4">
        <h2 className="text-[15px] text-[var(--sf-text-1)]">{title}</h2>
        <p className="mt-2 text-[13px] text-[var(--sf-text-2)]">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            className="h-8 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] text-[var(--sf-text-1)]"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="h-8 rounded-lg bg-[var(--sf-text-1)] px-3 text-[13px] text-[var(--sf-ground)]"
            onClick={onConfirm}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

export function ArtifactDetailView({
  meta,
  preview,
  imageUrl,
  onBack,
  onOpenRun,
  onOpenStage,
  versions,
  onOpenVersion,
  viewing,
  onViewLatest,
  canDelete,
  onDelete,
  confirmDelete,
  onConfirmDelete,
  onCancelDelete,
  actionError,
}: {
  meta: ArtifactDetailMeta;
  preview: StaticPreview | null;
  imageUrl?: string | null;
  onBack: () => void;
  onOpenRun?: () => void;
  onOpenStage?: () => void;
  versions?: ArtifactVersionRowModel[];
  onOpenVersion?: (version: number) => void;
  viewing?: { version: number; latest: number } | null;
  onViewLatest?: () => void;
  canDelete?: boolean;
  onDelete?: () => void;
  confirmDelete?: { title: string; body: string } | null;
  onConfirmDelete?: () => void;
  onCancelDelete?: () => void;
  actionError?: string | null;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <PageHeader
        title={meta.title}
        crumbs={[{ label: "Artifacts", onClick: onBack }]}
      />
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto px-5 py-4">
          {viewing ? (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-[var(--sf-hairline)] bg-[var(--sf-raised)] px-3 py-2 text-[13px] text-[var(--sf-text-1)]">
              <span>{viewingVersionBanner(viewing.version, viewing.latest)}</span>
              <button type="button" className="underline decoration-[var(--sf-hairline)]" onClick={onViewLatest}>
                View latest
              </button>
            </div>
          ) : null}
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
            {versions ? <VersionsSection versions={versions} onOpenVersion={onOpenVersion} /> : null}
            {canDelete ? (
              <div className="py-3">
                <button
                  type="button"
                  className="h-8 rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] text-[var(--sf-fail)]"
                  onClick={onDelete}
                >
                  Delete
                </button>
                {actionError ? (
                  <p role="alert" className="mt-2 text-[13px] text-[var(--sf-fail)]">
                    {actionError}
                  </p>
                ) : null}
              </div>
            ) : null}
          </dl>
        </Inspector>
      </div>
      {confirmDelete && onConfirmDelete && onCancelDelete ? (
        <DeleteArtifactDialog
          title={confirmDelete.title}
          body={confirmDelete.body}
          onConfirm={onConfirmDelete}
          onCancel={onCancelDelete}
        />
      ) : null}
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
  version,
}: {
  ownerKey: string;
  id: string;
  projectRoot?: string;
  version?: number;
}) {
  const [record, setRecord] = useState<ArtifactRecord | null>(null);
  const [versions, setVersions] = useState<ArtifactVersionRecord[]>([]);
  const [payload, setPayload] = useState<ArtifactContentPayload | null>(null);
  const [contentError, setContentError] = useState<ArtifactRequestError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let imageUrl: string | null = null;
    setLoading(true);
    setError(null);
    setRecord(null);
    setPayload(null);
    setContentError(null);
    setConfirming(false);
    setDeleteError(null);
    void (async () => {
      try {
        const [next, versionPage] = await Promise.all([
          fetchArtifact(ownerKey, id, projectRoot, version),
          fetchArtifactVersions(ownerKey, id, projectRoot).catch(() => ({ versions: [] as ArtifactVersionRecord[] })),
        ]);
        if (cancelled) return;
        setRecord(next);
        setVersions(versionPage.versions);
        if (next.status === "expired") {
          setLoading(false);
          return;
        }
        try {
          const body = await fetchArtifactContent(ownerKey, id, projectRoot, version);
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
  }, [ownerKey, id, projectRoot, version]);

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
  const displayRecord = recordForViewedVersion(record, versions, version);
  const view = payloadPreview(displayRecord, payload, contentError);
  const meta = artifactDetailMeta(displayRecord, view.hash);
  const versionRows = artifactVersionRows(versions);
  const latest = versions.find((item) => item.current)?.version ?? record.version;
  const viewing = version !== undefined && version !== latest ? { version, latest } : null;
  const confirm = confirming ? deleteArtifactConfirm(record.title, Math.max(versions.length, 1)) : null;
  return (
    <ArtifactDetailView
      meta={meta}
      preview={loading ? null : view.preview}
      imageUrl={view.imageUrl}
      onBack={() => navigate(artifactsPath())}
      onOpenRun={meta.runPath ? () => navigate(meta.runPath!) : undefined}
      onOpenStage={meta.stagePath ? () => navigate(meta.stagePath!) : undefined}
      versions={versionRows}
      onOpenVersion={(next) => navigate(artifactDetailPath(ownerKey, id, projectRoot, next))}
      viewing={viewing}
      onViewLatest={() => navigate(artifactDetailPath(ownerKey, id, projectRoot))}
      canDelete={record.origin === "published"}
      onDelete={() => setConfirming(true)}
      confirmDelete={confirm}
      onCancelDelete={() => setConfirming(false)}
      actionError={deleteError}
      onConfirmDelete={() => {
        if (deleting) return;
        setDeleting(true);
        setDeleteError(null);
        void deleteArtifact(ownerKey, id, projectRoot)
          .then(() => navigate(artifactsPath()))
          .catch((err: unknown) => {
            setDeleting(false);
            setConfirming(false);
            setDeleteError(err instanceof Error ? err.message : String(err));
          });
      }}
    />
  );
}

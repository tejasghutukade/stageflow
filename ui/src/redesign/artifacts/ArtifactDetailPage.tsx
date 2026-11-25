import { useEffect, useState, type ReactNode } from "react";
import {
  ArtifactRequestError,
  deleteArtifact,
  fetchArtifact,
  fetchArtifactContent,
  fetchArtifactData,
  fetchArtifactVersions,
  refreshArtifact,
  type ArtifactContentPayload,
  type ArtifactDataResponse,
  type ArtifactLiveView,
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
  compactJson,
  deleteArtifactConfirm,
  formatLiveSnapshotJson,
  LIVE_RENDERER_NOTE,
  LIVE_VERSION_SNAPSHOT_NOTE,
  recordForViewedVersion,
  viewingVersionBanner,
  type ArtifactDetailMeta,
  type ArtifactVersionRowModel,
} from "./artifactDetailModel";
import { artifactLiveStatusPill, artifactStatusPillClass } from "./artifactsPageModel";
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

function LiveSection({
  live,
  data,
  historical,
  refreshing,
  refreshError,
  onRefresh,
}: {
  live: ArtifactLiveView;
  data: ArtifactDataResponse | null;
  historical: boolean;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh?: () => void;
}) {
  const status = data?.status ?? live.status;
  const pill =
    status === "fresh" || status === "stale" || status === "error" || status === "refreshing"
      ? artifactLiveStatusPill(status)
      : { label: "Live", variant: "muted" as const };
  const refreshed = data?.last_refreshed_at ?? live.last_refreshed_at ?? null;
  const errorCode = data?.last_error_code ?? live.last_error_code ?? null;
  const bindings = live.bindings ?? [];
  return (
    <div className="border-b border-[var(--sf-hairline)] py-2">
      <div className="text-[11px] uppercase tracking-wide text-[var(--sf-text-3)]">Live</div>
      <div className="mt-2 flex flex-col gap-2">
        <span className={artifactStatusPillClass(pill.variant)}>
          <span className="sf-pill__label">{pill.label}</span>
        </span>
        <div className="text-[13px] text-[var(--sf-text-1)]">Last refreshed {refreshed ?? "—"}</div>
        <div className="text-[13px] text-[var(--sf-text-1)]">Last error {errorCode ?? "—"}</div>
        {bindings.map((binding) => (
          <div key={binding.id} className="text-[13px] text-[var(--sf-text-1)]">
            <span className="sf-mono">{binding.id}</span>
            <span> {binding.function} </span>
            <span className="sf-mono">{compactJson(binding.args)}</span>
            <span className="sf-pill ml-2">
              <span className="sf-pill__label">Read-only</span>
            </span>
          </div>
        ))}
        {historical ? <p className="text-[13px] text-[var(--sf-text-2)]">{LIVE_VERSION_SNAPSHOT_NOTE}</p> : null}
        {(data?.snapshots ?? []).map((snapshot) => {
          const shown = formatLiveSnapshotJson(snapshot.value);
          return (
            <details key={`${snapshot.binding_id}:${snapshot.args_hash}`}>
              <summary className="cursor-pointer text-[13px] text-[var(--sf-text-1)]">
                {snapshot.binding_id} {snapshot.status}
              </summary>
              <pre className="sf-mono mt-1 whitespace-pre-wrap text-[12px] text-[var(--sf-text-1)]">{shown.text}</pre>
              {shown.truncated ? (
                <p className="text-[12px] text-[var(--sf-text-3)]">showing first {shown.capKb} KB</p>
              ) : null}
            </details>
          );
        })}
        {onRefresh ? (
          <button
            type="button"
            className="h-8 w-fit rounded-lg border border-[var(--sf-hairline-strong)] px-3 text-[13px] text-[var(--sf-text-1)] disabled:opacity-50"
            disabled={refreshing}
            onClick={onRefresh}
          >
            {refreshing ? "Refreshing…" : "Refresh now"}
          </button>
        ) : null}
        {refreshError ? (
          <p role="alert" className="text-[13px] text-[var(--sf-fail)]">
            {refreshError}
          </p>
        ) : null}
      </div>
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
  onOpenOwner,
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
  program,
  live,
  liveData,
  historicalSnapshots,
  refreshing,
  refreshError,
  onRefresh,
}: {
  meta: ArtifactDetailMeta;
  preview: StaticPreview | null;
  imageUrl?: string | null;
  onBack: () => void;
  onOpenRun?: () => void;
  onOpenStage?: () => void;
  onOpenOwner?: () => void;
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
  program?: string | null;
  live?: ArtifactLiveView | null;
  liveData?: ArtifactDataResponse | null;
  historicalSnapshots?: boolean;
  refreshing?: boolean;
  refreshError?: string | null;
  onRefresh?: () => void;
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
          {meta.kind === "live.declarative" ? (
            <div>
              <p className="mb-3 text-[13px] text-[var(--sf-text-2)]">{LIVE_RENDERER_NOTE}</p>
              <pre className="sf-mono whitespace-pre-wrap text-[13px] text-[var(--sf-text-1)]">{program ?? ""}</pre>
            </div>
          ) : preview ? (
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
            <MetaLine label="Owner">
              {meta.ownerPath && onOpenOwner ? (
                <LinkButton label={meta.ownerLabel} onClick={onOpenOwner} />
              ) : (
                meta.ownerLabel
              )}
            </MetaLine>
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
            {live ? (
              <LiveSection
                live={live}
                data={liveData ?? null}
                historical={historicalSnapshots === true}
                refreshing={refreshing === true}
                refreshError={refreshError ?? null}
                onRefresh={onRefresh}
              />
            ) : null}
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
  const [liveData, setLiveData] = useState<ArtifactDataResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

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
    setLiveData(null);
    setRefreshError(null);
    setRefreshing(false);
    void (async () => {
      try {
        const [next, versionPage] = await Promise.all([
          fetchArtifact(ownerKey, id, projectRoot, version),
          fetchArtifactVersions(ownerKey, id, projectRoot).catch(() => ({ versions: [] as ArtifactVersionRecord[] })),
        ]);
        if (cancelled) return;
        setRecord(next);
        setVersions(versionPage.versions);
        if (next.kind === "live.declarative" || next.live) {
          try {
            const data = await fetchArtifactData(ownerKey, id, projectRoot);
            if (!cancelled) setLiveData(data);
          } catch (err) {
            if (!cancelled) setRefreshError(err instanceof Error ? err.message : String(err));
          }
        }
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
      onOpenOwner={meta.ownerPath ? () => navigate(meta.ownerPath!) : undefined}
      versions={versionRows}
      onOpenVersion={(next) => navigate(artifactDetailPath(ownerKey, id, projectRoot, next))}
      viewing={viewing}
      onViewLatest={() => navigate(artifactDetailPath(ownerKey, id, projectRoot))}
      canDelete={record.origin === "published"}
      onDelete={() => setConfirming(true)}
      confirmDelete={confirm}
      onCancelDelete={() => setConfirming(false)}
      actionError={deleteError}
      program={view.preview && "text" in view.preview ? view.preview.text : payload?.kind === "text" ? payload.text : null}
      live={displayRecord.live ?? null}
      liveData={liveData}
      historicalSnapshots={viewing !== null}
      refreshing={refreshing}
      refreshError={refreshError}
      onRefresh={
        displayRecord.kind === "live.declarative" && viewing === null
          ? () => {
              if (refreshing) return;
              setRefreshing(true);
              setRefreshError(null);
              void refreshArtifact(ownerKey, id, projectRoot)
                .then((data) => {
                  setLiveData(data);
                  setRecord((current) =>
                    current?.live
                      ? {
                          ...current,
                          live: {
                            ...current.live,
                            status: data.status === "fresh" || data.status === "stale" || data.status === "error" || data.status === "refreshing" ? data.status : current.live.status,
                            last_refreshed_at: data.last_refreshed_at,
                            last_error_code: data.last_error_code,
                          },
                        }
                      : current,
                  );
                })
                .catch((err: unknown) => {
                  setRefreshError(err instanceof Error ? err.message : String(err));
                })
                .finally(() => setRefreshing(false));
            }
          : undefined
      }
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

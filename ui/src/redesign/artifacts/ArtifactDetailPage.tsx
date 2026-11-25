import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  ArtifactRequestError,
  deleteArtifact,
  fetchArtifact,
  fetchArtifactContent,
  fetchArtifactVersions,
  type ArtifactContentPayload,
  type ArtifactDataResponse,
  type ArtifactLiveView,
  type ArtifactOriginView,
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
  formatLiveRefreshed,
  formatLiveSnapshotJson,
  liveExpiryPreview,
  LIVE_VERSION_SNAPSHOT_NOTE,
  showLiveRefresh,
  recordForViewedVersion,
  viewingVersionBanner,
  type ArtifactDetailMeta,
  type ArtifactVersionRowModel,
} from "./artifactDetailModel";
import { artifactLiveStatusPill, artifactStatusPillClass } from "./artifactsPageModel";
import { autoRefreshNote, formatUpdatedAgo } from "./liveRefreshSchedule";
import { useLiveArtifactData } from "./useLiveArtifactData";
import { previewFromContent, type StaticPreview } from "./renderers/previewModel";
import { StaticArtifactBody } from "./renderers/StaticPreview";
import type { LivePreviewInput } from "./livePreview";
import type { LiveHtmlFrameProps } from "./liveHtml/LiveHtmlFrame";

const LiveArtifactRenderer = lazy(() =>
  import("./live/LiveArtifactRenderer").then((mod) => ({ default: mod.LiveArtifactRenderer })),
);

const LiveHtmlFrame = lazy(() =>
  import("./liveHtml/LiveHtmlFrame").then((mod) => ({ default: mod.LiveHtmlFrame })),
);

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
  updatedAgo,
  autoNote,
  nowMs,
  onRefresh,
  onReviewOrigins,
}: {
  live: ArtifactLiveView;
  data: ArtifactDataResponse | null;
  historical: boolean;
  refreshing: boolean;
  refreshError: string | null;
  updatedAgo?: string | null;
  autoNote?: string | null;
  nowMs?: number;
  onRefresh?: () => void;
  onReviewOrigins?: () => void;
}) {
  const status = data?.status ?? live.status;
  const pill =
    status === "fresh" || status === "stale" || status === "error" || status === "refreshing"
      ? artifactLiveStatusPill(status)
      : { label: "Live", variant: "muted" as const };
  const refreshed = formatLiveRefreshed(data?.last_refreshed_at ?? live.last_refreshed_at ?? null, nowMs ?? Date.now());
  const errorCode = data?.last_error_code ?? live.last_error_code ?? null;
  const bindings = live.bindings ?? [];
  return (
    <div className="border-b border-[var(--sf-hairline)] py-2">
      <div className="text-[11px] uppercase tracking-wide text-[var(--sf-text-3)]">Live</div>
      <div className="mt-2 flex flex-col gap-2">
        <span className={artifactStatusPillClass(pill.variant)}>
          <span className="sf-pill__label">{pill.label}</span>
        </span>
        <div className="text-[13px] text-[var(--sf-text-1)]" title={refreshed.title ?? undefined}>
          Last refreshed {refreshed.label}
        </div>
        {updatedAgo ? <div className="text-[13px] text-[var(--sf-text-2)]">{updatedAgo}</div> : null}
        {autoNote ? <div className="text-[13px] text-[var(--sf-text-2)]">{autoNote}</div> : null}
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
        {live.csp || live.origins ? (
          <div className="text-[13px] text-[var(--sf-text-1)]">
            Origins: {originApprovalLabel(live)}
            {onReviewOrigins && originApprovalLabel(live) === "not approved" ? (
              <button
                type="button"
                className="ml-2 h-7 rounded-lg border border-[var(--sf-hairline-strong)] px-2 text-[12px] text-[var(--sf-text-1)]"
                onClick={onReviewOrigins}
              >
                Review origins
              </button>
            ) : null}
          </div>
        ) : null}
        {live.csp ? (
          <div className="text-[13px] text-[var(--sf-text-1)]">
            <div className="text-[11px] uppercase tracking-wide text-[var(--sf-text-3)]">Declared origins</div>
            <div>connect: {(live.csp.connectDomains ?? []).join(" ") || "none"}</div>
            <div>resource: {(live.csp.resourceDomains ?? []).join(" ") || "none"}</div>
            <div>frame: {(live.csp.frameDomains ?? []).join(" ") || "none"}</div>
            <div>base: {(live.csp.baseUriDomains ?? []).join(" ") || "none"}</div>
          </div>
        ) : null}
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

function originApprovalLabel(live: ArtifactLiveView): string {
  const connect = live.csp?.connectDomains?.length ?? 0;
  const resource = live.csp?.resourceDomains?.length ?? 0;
  const base = live.csp?.baseUriDomains?.length ?? 0;
  const declared = connect + resource + base;
  const origins = live.origins;
  const listed = origins ? origins.connect.length + origins.resource.length + origins.base.length : 0;
  if (declared === 0 && listed === 0) return "none";
  if (origins?.approved && (declared > 0 || listed > 0)) return "approved";
  if (declared > 0 || listed > 0) return "not approved";
  return "none";
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
  updatedAgo,
  autoNote,
  nowMs,
  onRefresh,
  onReviewOrigins,
  livePreview,
  liveHtml,
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
  updatedAgo?: string | null;
  autoNote?: string | null;
  nowMs?: number;
  onRefresh?: () => void;
  onReviewOrigins?: () => void;
  livePreview?: LivePreviewInput | null;
  liveHtml?: LiveHtmlFrameProps | null;
}) {
  const showLiveProgram = meta.kind === "live.declarative" && preview?.mode !== "unavailable";
  const showLiveHtml = meta.kind === "live.html" && preview?.mode !== "unavailable";
  const refresh = preview?.mode === "unavailable" ? undefined : onRefresh;
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
          {preview?.mode === "unavailable" ? (
            <StaticArtifactBody preview={preview} imageUrl={imageUrl} imageAlt={meta.title} />
          ) : showLiveHtml ? (
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
              <details className="mt-4">
                <summary className="cursor-pointer text-[13px] text-[var(--sf-text-2)]">HTML source</summary>
                <pre className="sf-mono mt-2 whitespace-pre-wrap text-[13px] text-[var(--sf-text-1)]">{liveHtml?.html ?? ""}</pre>
              </details>
            </div>
          ) : showLiveProgram ? (
            <div>
              {livePreview ? (
                <Suspense fallback={<p className="text-[13px] text-[var(--sf-text-3)]">Loading live preview…</p>}>
                  <LiveArtifactRenderer {...livePreview} />
                </Suspense>
              ) : (
                <p className="text-[13px] text-[var(--sf-text-3)]">Loading live preview…</p>
              )}
              <details className="mt-4">
                <summary className="cursor-pointer text-[13px] text-[var(--sf-text-2)]">Program source</summary>
                <pre className="sf-mono mt-2 whitespace-pre-wrap text-[13px] text-[var(--sf-text-1)]">{program ?? ""}</pre>
              </details>
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
                updatedAgo={updatedAgo}
                autoNote={autoNote}
                nowMs={nowMs}
                onRefresh={refresh}
                onReviewOrigins={onReviewOrigins}
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
  const [originReview, setOriginReview] = useState(0);
  const latestVersion = versions.length === 0
    ? undefined
    : versions.find((item) => item.current)?.version ?? versions.reduce((max, item) => Math.max(max, item.version), 0);
  const live = useLiveArtifactData(record, {
    ownerKey,
    id,
    projectRoot,
    version,
    latestVersion,
    hidden: false,
    onRecord: (next) => {
      setRecord((current) => {
        if (!current?.live || current.version !== next.version) return current;
        const previous = current.live.origins;
        const incoming = next.live?.origins;
        const previousKey = previous ? `${previous.hash}:${previous.approved}:${previous.approved_at ?? ""}` : "";
        const incomingKey = incoming ? `${incoming.hash}:${incoming.approved}:${incoming.approved_at ?? ""}` : "";
        if (previousKey === incomingKey) return current;
        return { ...current, live: { ...current.live, origins: incoming } };
      });
    },
  });

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
  const expiry = liveExpiryPreview(displayRecord, live.unavailable, live.unavailableMessage);
  const preview = expiry ?? view.preview;
  const meta = artifactDetailMeta(displayRecord, view.hash);
  const versionRows = artifactVersionRows(versions);
  const viewing = version !== undefined && latestVersion !== undefined && version !== latestVersion
    ? { version, latest: latestVersion }
    : null;
  const confirm = confirming ? deleteArtifactConfirm(record.title, Math.max(versions.length, 1)) : null;
  const liveData: ArtifactDataResponse | null =
    displayRecord.kind === "live.declarative" || displayRecord.live
      ? {
          status: live.status,
          snapshots: live.snapshots,
          last_refreshed_at: live.lastRefreshedAt,
          last_error_code: live.lastErrorCode,
          errors: live.errors,
        }
      : null;
  const autoSeconds = viewing ? null : displayRecord.live?.refresh?.auto_seconds;
  return (
    <ArtifactDetailView
      meta={meta}
      preview={preview}
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
      refreshing={live.refreshing}
      refreshError={live.unavailable ? null : live.lastError}
      updatedAgo={expiry ? null : formatUpdatedAgo(live.lastRefreshedAt, Date.now())}
      autoNote={
        expiry
          ? null
          : autoRefreshNote(
              typeof autoSeconds === "number" ? autoSeconds : null,
              displayRecord.live?.refresh?.ttl_seconds,
            )
      }
      onRefresh={
        showLiveRefresh(displayRecord.kind, viewing !== null, Boolean(expiry)) ? () => live.refresh() : undefined
      }
      onReviewOrigins={() => setOriginReview((value) => value + 1)}
      livePreview={
        expiry || displayRecord.kind !== "live.declarative"
          ? null
          : {
              format: displayRecord.live?.format,
              library: displayRecord.live?.library,
              program: view.preview && "text" in view.preview ? view.preview.text : payload?.kind === "text" ? payload.text : "",
              bindings: displayRecord.live?.bindings ?? [],
              snapshots: live.snapshots,
              status: live.status,
              lastRefreshedAt: live.lastRefreshedAt,
              lastErrorCode: live.lastErrorCode,
              settled: live.settled,
              refreshing: live.refreshing,
              historical: viewing !== null,
              ownerKey,
              artifactId: id,
              projectRoot,
            }
      }
      liveHtml={
        expiry || displayRecord.kind !== "live.html"
          ? null
          : {
              record: displayRecord,
              version: displayRecord.version,
              html: contentError || payload?.kind !== "text" ? null : payload.text,
              htmlError: contentError
                ? contentError.message
                : payload && payload.kind !== "text"
                  ? "This file cannot be shown as HTML"
                  : null,
              historical: viewing !== null,
              snapshots: live.snapshots,
              settled: live.settled,
              refreshing: live.refreshing,
              ownerKey,
              artifactId: id,
              projectRoot,
              reviewToken: originReview,
              onOrigins: (origins: ArtifactOriginView) => {
                setRecord((current) =>
                  current?.live ? { ...current, live: { ...current.live, origins } } : current,
                );
              },
            }
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

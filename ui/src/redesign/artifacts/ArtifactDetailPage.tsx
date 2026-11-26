import { useState, type ReactNode } from "react";
import { deleteArtifact, type ArtifactDataResponse, type ArtifactLiveView } from "../../api/artifacts";
import { artifactDetailPath, artifactsPath, navigate } from "../../routes";
import { MODAL_SCRIM_PT, OVERLAY_SCRIM_CLASS } from "../overlay/overlayScrimClasses";
import { Inspector } from "../shell/Inspector";
import { PageHeader } from "../shell/PageHeader";
import {
  artifactVersionRows,
  compactJson,
  deleteArtifactConfirm,
  formatLiveRefreshed,
  formatLiveSnapshotJson,
  LIVE_VERSION_SNAPSHOT_NOTE,
  type ArtifactDetailMeta,
  type ArtifactVersionRowModel,
} from "./artifactDetailModel";
import { artifactLiveStatusPill, artifactStatusPillClass } from "./artifactsPageModel";
import { useArtifactViewModel } from "./artifactViewModel";
import { ArtifactViewContent } from "./ArtifactView";
import type { StaticPreview } from "./renderers/previewModel";
import type { LivePreviewInput } from "./livePreview";
import type { LiveHtmlFrameProps } from "./liveHtml/LiveHtmlFrame";

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
  const refresh = preview?.mode === "unavailable" ? undefined : onRefresh;
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--sf-ground)]">
      <PageHeader
        title={meta.title}
        crumbs={[{ label: "Artifacts", onClick: onBack }]}
      />
      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto px-5 py-4">
          <ArtifactViewContent
            density="page"
            meta={meta}
            preview={preview}
            imageUrl={imageUrl}
            program={program}
            livePreview={livePreview}
            liveHtml={liveHtml}
            historicalSnapshots={historicalSnapshots}
            viewing={viewing}
            onViewLatest={onViewLatest}
          />
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
  const model = useArtifactViewModel({ ownerKey, id, projectRoot, version });
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  if (model.phase === "error" && !model.record) {
    const error = model.message;
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[var(--sf-ground)]">
        <PageHeader title="Artifact" crumbs={[{ label: "Artifacts", onClick: () => navigate(artifactsPath()) }]} />
        <p className="px-5 py-4 text-[13px] text-[var(--sf-fail)]">{error}</p>
      </div>
    );
  }
  if (model.phase === "loading") {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[var(--sf-ground)]">
        <PageHeader title="Artifact" crumbs={[{ label: "Artifacts", onClick: () => navigate(artifactsPath()) }]} />
        <p className="px-5 py-4 text-[13px] text-[var(--sf-text-3)]">Loading artifact…</p>
      </div>
    );
  }
  if (model.phase !== "ready") {
    return (
      <div className="flex min-h-0 flex-1 flex-col bg-[var(--sf-ground)]">
        <PageHeader title="Artifact" crumbs={[{ label: "Artifacts", onClick: () => navigate(artifactsPath()) }]} />
        <p className="px-5 py-4 text-[13px] text-[var(--sf-fail)]">{model.message}</p>
      </div>
    );
  }
  const { record, versions } = model;
  const versionRows = artifactVersionRows(versions);
  const confirm = confirming ? deleteArtifactConfirm(record.title, Math.max(versions.length, 1)) : null;
  return (
    <ArtifactDetailView
      meta={model.meta}
      preview={model.preview}
      imageUrl={model.imageUrl}
      onBack={() => navigate(artifactsPath())}
      onOpenRun={model.meta.runPath ? () => navigate(model.meta.runPath!) : undefined}
      onOpenStage={model.meta.stagePath ? () => navigate(model.meta.stagePath!) : undefined}
      onOpenOwner={model.meta.ownerPath ? () => navigate(model.meta.ownerPath!) : undefined}
      versions={versionRows}
      onOpenVersion={(next) => navigate(artifactDetailPath(ownerKey, id, projectRoot, next))}
      viewing={model.viewing}
      onViewLatest={() => navigate(artifactDetailPath(ownerKey, id, projectRoot))}
      canDelete={record.origin === "published"}
      onDelete={() => setConfirming(true)}
      confirmDelete={confirm}
      onCancelDelete={() => setConfirming(false)}
      actionError={deleteError}
      program={model.program}
      live={model.live}
      liveData={model.liveData}
      historicalSnapshots={model.historicalSnapshots}
      refreshing={model.refreshing}
      refreshError={model.refreshError}
      updatedAgo={model.updatedAgo}
      autoNote={model.autoNote}
      onRefresh={model.onRefresh}
      onReviewOrigins={model.onReviewOrigins}
      livePreview={model.livePreview}
      liveHtml={model.liveHtml}
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

import { useEffect, useRef, useState } from "react";
import {
  ArtifactRequestError,
  fetchArtifact,
  fetchArtifactContent,
  fetchArtifactVersions,
  type ArtifactContentPayload,
  type ArtifactDataResponse,
  type ArtifactOriginView,
  type ArtifactRecord,
  type ArtifactVersionRecord,
} from "../../api/artifacts";
import {
  artifactDetailMeta,
  liveExpiryPreview,
  recordForViewedVersion,
  showLiveRefresh,
  type ArtifactDetailMeta,
} from "./artifactDetailModel";
import { autoRefreshNote, formatUpdatedAgo } from "./liveRefreshSchedule";
import { useLiveArtifactData } from "./useLiveArtifactData";
import { previewFromContent, type StaticPreview } from "./renderers/previewModel";
import type { LivePreviewInput } from "./livePreview";
import type { LiveHtmlFrameProps } from "./liveHtml/LiveHtmlFrame";

export type ArtifactViewIdentity = {
  ownerKey: string;
  id: string;
  projectRoot?: string;
  version?: number;
};

export type ArtifactViewReady = {
  phase: "ready";
  record: ArtifactRecord;
  versions: ArtifactVersionRecord[];
  displayRecord: ArtifactRecord;
  meta: ArtifactDetailMeta;
  preview: StaticPreview;
  imageUrl: string | null;
  contentError: ArtifactRequestError | null;
  program: string | null;
  live: ArtifactRecord["live"];
  liveData: ArtifactDataResponse | null;
  livePreview: LivePreviewInput | null;
  liveHtml: LiveHtmlFrameProps | null;
  historicalSnapshots: boolean;
  viewing: { version: number; latest: number } | null;
  latestVersion: number | undefined;
  updatedAgo: string | null;
  autoNote: string | null;
  refreshing: boolean;
  refreshError: string | null;
  onRefresh?: () => void;
  onReviewOrigins: () => void;
  onOrigins: (origins: ArtifactOriginView) => void;
  originReview: number;
  bumpOriginReview: () => void;
};

export type ArtifactViewModel =
  | { phase: "loading" }
  | { phase: "error"; message: string; record: ArtifactRecord | null }
  | ArtifactViewReady;

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

export function useArtifactViewModel(identity: ArtifactViewIdentity): ArtifactViewModel {
  const { ownerKey, id, projectRoot, version } = identity;
  const originsEpoch = useRef(0);
  const [record, setRecord] = useState<ArtifactRecord | null>(null);
  const [versions, setVersions] = useState<ArtifactVersionRecord[]>([]);
  const [payload, setPayload] = useState<ArtifactContentPayload | null>(null);
  const [contentError, setContentError] = useState<ArtifactRequestError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [originReview, setOriginReview] = useState(0);

  const latestVersion =
    versions.length === 0
      ? undefined
      : versions.find((item) => item.current)?.version ??
        versions.reduce((max, item) => Math.max(max, item.version), 0);

  const live = useLiveArtifactData(record, {
    ownerKey,
    id,
    projectRoot,
    version,
    latestVersion,
    hidden: false,
    recordEpoch: () => originsEpoch.current,
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

  if (loading) return { phase: "loading" };
  if (error && !record) return { phase: "error", message: error, record: null };

  if (!record) return { phase: "loading" };

  const displayRecord = recordForViewedVersion(record, versions, version);
  const view = payloadPreview(displayRecord, payload, contentError);
  const expiry = liveExpiryPreview(displayRecord, live.unavailable, live.unavailableMessage);
  const preview = expiry ?? view.preview;
  const meta = artifactDetailMeta(displayRecord, view.hash);
  const viewing =
    version !== undefined && latestVersion !== undefined && version !== latestVersion
      ? { version, latest: latestVersion }
      : null;
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
  const program =
    view.preview && "text" in view.preview
      ? view.preview.text
      : payload?.kind === "text"
        ? payload.text
        : null;

  return {
    phase: "ready",
    record,
    versions,
    displayRecord,
    meta,
    preview,
    imageUrl: view.imageUrl,
    contentError,
    program,
    live: displayRecord.live ?? undefined,
    liveData,
    historicalSnapshots: viewing !== null,
    viewing,
    latestVersion,
    updatedAgo: expiry ? null : formatUpdatedAgo(live.lastRefreshedAt, Date.now()),
    autoNote: expiry
      ? null
      : autoRefreshNote(
          typeof autoSeconds === "number" ? autoSeconds : null,
          displayRecord.live?.refresh?.ttl_seconds,
        ),
    refreshing: live.refreshing,
    refreshError: live.unavailable ? null : live.lastError,
    onRefresh: showLiveRefresh(displayRecord.kind, viewing !== null, Boolean(expiry))
      ? () => live.refresh()
      : undefined,
    originReview,
    bumpOriginReview: () => setOriginReview((value) => value + 1),
    onReviewOrigins: () => setOriginReview((value) => value + 1),
    onOrigins: (origins: ArtifactOriginView) => {
      originsEpoch.current += 1;
      setRecord((current) => (current?.live ? { ...current, live: { ...current.live, origins } } : current));
    },
    livePreview:
      expiry || displayRecord.kind !== "live.declarative"
        ? null
        : {
            format: displayRecord.live?.format,
            library: displayRecord.live?.library,
            program: program ?? "",
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
          },
    liveHtml:
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
              originsEpoch.current += 1;
              setRecord((current) => (current?.live ? { ...current, live: { ...current.live, origins } } : current));
            },
          },
  };
}
import type { BindingQueryResult } from "../artifacts/bindingQuery.js";
import type { ArtifactRefreshResult } from "../artifacts/refresh.js";
import type { ArtifactOwner, ArtifactLiveView, ArtifactRecord } from "../artifacts/record.js";
import { publicArtifactKey } from "../artifacts/keys.js";

export function ownerDisplayText(owner: ArtifactOwner): string {
  if (owner.kind === "agent") return `agent:${owner.agent}`;
  return `${owner.pipeline}:${owner.stage}`;
}

export function ownerKeyFromRecord(record: ArtifactRecord): string {
  if (record.owner.kind === "agent") return `agent:${record.owner.agent}`;
  return `stage:${record.owner.pipeline}:${record.owner.stage}`;
}

export function matchesOwnerFilter(record: ArtifactRecord, filter: string): boolean {
  const trimmed = filter.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith("stage:")) {
    return ownerKeyFromRecord(record) === trimmed;
  }
  if (trimmed.startsWith("agent:")) {
    return ownerKeyFromRecord(record) === trimmed;
  }
  if (record.owner.kind === "agent") {
    return record.owner.agent === trimmed || `agent:${record.owner.agent}` === trimmed;
  }
  const needle = `${record.owner.pipeline}:${record.owner.stage}`;
  return needle === trimmed;
}

export function matchesKindFilter(record: ArtifactRecord, kind: string | undefined): boolean {
  if (kind === undefined || kind.trim() === "") return true;
  return record.kind === kind.trim();
}

export function matchesLiveFilter(record: ArtifactRecord, live: boolean | undefined): boolean {
  if (live === undefined) return true;
  const isLive = record.kind.startsWith("live.");
  return live ? isLive : !isLive;
}

export function matchesTextQuery(record: ArtifactRecord, q: string | undefined): boolean {
  if (q === undefined || q.trim() === "") return true;
  const needle = q.trim().toLowerCase();
  const haystacks = [
    record.title,
    record.id,
    record.key,
    ownerDisplayText(record.owner),
    ownerKeyFromRecord(record),
  ];
  return haystacks.some((value) => value.toLowerCase().includes(needle));
}

export function applyClientFilters(
  records: ArtifactRecord[],
  filters: {
    q?: string;
    kind?: string;
    owner?: string;
    live?: boolean;
  },
): ArtifactRecord[] {
  return records.filter(
    (record) =>
      matchesTextQuery(record, filters.q) &&
      matchesKindFilter(record, filters.kind) &&
      matchesOwnerFilter(record, filters.owner ?? "") &&
      matchesLiveFilter(record, filters.live),
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same rule as the console `runShortId` in ui/src/catalogJoin.ts. */
export function artifactRunShortId(runId: string): string {
  if (UUID_RE.test(runId)) return runId.slice(0, 8);
  if (/^\d{4}-\d{2}-\d{2}/.test(runId)) {
    const suffix = runId.replace(/^\d{4}-\d{2}-\d{2}[T\-_:.Z]*/i, "").replace(/[^\w]/g, "");
    if (suffix.length >= 4) return suffix.slice(0, 8);
    const parsed = Date.parse(runId);
    if (Number.isFinite(parsed)) {
      const d = new Date(parsed);
      const hex = parsed.toString(36).replace(/[^\w]/g, "");
      if (hex.length >= 4) return hex.slice(-8);
      return `${d.getUTCMonth() + 1}${d.getUTCDate()}${d.getUTCHours()}${d.getUTCMinutes()}`.slice(0, 8);
    }
  }
  if (runId.length <= 8) return runId;
  return runId.slice(-8);
}

function shortRunId(runId: string | null): string {
  if (runId === null || runId.length === 0) return "-";
  return artifactRunShortId(runId);
}

function formatRefreshPolicy(refresh: ArtifactLiveView["refresh"]): string {
  if (!refresh) return "-";
  const parts: string[] = [];
  if (refresh.on_view !== undefined) parts.push(`on_view=${refresh.on_view}`);
  if (refresh.ttl_seconds !== undefined) parts.push(`ttl_seconds=${refresh.ttl_seconds}`);
  if (refresh.auto_seconds !== undefined) parts.push(`auto_seconds=${refresh.auto_seconds}`);
  return parts.length > 0 ? parts.join(" ") : "-";
}

export function formatArtifactQuery(result: BindingQueryResult): string {
  const snapshot = result.snapshot;
  const lines = [
    `binding: ${result.binding_id}`,
    `args_hash: ${result.args_hash}`,
    `source: ${snapshot?.source ?? "-"}`,
    `status: ${snapshot?.status ?? "-"}`,
  ];
  if (snapshot?.error_code) lines.push(`snapshot_error: ${snapshot.error_code}`);
  for (const error of result.errors) lines.push(`error: ${error.code}`);
  if (result.retry_after_seconds !== undefined) lines.push(`retry_after_seconds: ${result.retry_after_seconds}`);
  return lines.join("\n");
}

export function formatArtifactRefresh(result: ArtifactRefreshResult): string {
  const lines = [
    `status: ${result.status ?? "-"}`,
    `last refreshed: ${result.last_refreshed_at ?? "-"}`,
    `last error: ${result.last_error_code ?? "-"}`,
  ];
  for (const snapshot of result.snapshots) {
    lines.push(`${snapshot.binding_id}: ${snapshot.status}${snapshot.error_code ? ` ${snapshot.error_code}` : ""}`);
  }
  for (const error of result.errors) {
    lines.push(`${error.binding_id}: error ${error.code}`);
  }
  return lines.join("\n");
}

export function liveStatusMarker(record: Pick<ArtifactRecord, "status" | "kind" | "live">): string {
  if (record.status === "expired") return "expired";
  if (!record.kind.startsWith("live.")) return "";
  const status = record.live?.status;
  return status ? `LIVE/${status}` : "LIVE";
}

function formatUpdated(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${y}-${m}-${day} ${hh}:${mm}Z`;
}

export function formatArtifactListTable(records: ArtifactRecord[]): string[] {
  if (records.length === 0) return [];
  const rows = records.map((record) => ({
    key: publicArtifactKey(ownerKeyFromRecord(record), record.id),
    kind: record.kind,
    title: record.title,
    owner: ownerDisplayText(record.owner),
    run: shortRunId(record.source.run_id),
    status: liveStatusMarker(record),
    updated: formatUpdated(record.updated_at),
  }));
  const widths = {
    key: Math.max(3, ...rows.map((row) => row.key.length)),
    kind: Math.max(4, ...rows.map((row) => row.kind.length)),
    title: Math.max(5, ...rows.map((row) => row.title.length)),
    owner: Math.max(5, ...rows.map((row) => row.owner.length)),
    run: Math.max(3, ...rows.map((row) => row.run.length)),
    status: Math.max(6, ...rows.map((row) => row.status.length)),
    updated: Math.max(7, ...rows.map((row) => row.updated.length)),
  };
  const header = [
    "KEY".padEnd(widths.key),
    "KIND".padEnd(widths.kind),
    "TITLE".padEnd(widths.title),
    "OWNER".padEnd(widths.owner),
    "RUN".padEnd(widths.run),
    "STATUS".padEnd(widths.status),
    "UPDATED".padEnd(widths.updated),
  ].join("  ");
  const lines = [header];
  for (const row of rows) {
    lines.push(
      [
        row.key.padEnd(widths.key),
        row.kind.padEnd(widths.kind),
        row.title.padEnd(widths.title),
        row.owner.padEnd(widths.owner),
        row.run.padEnd(widths.run),
        row.status.padEnd(widths.status),
        row.updated.padEnd(widths.updated),
      ].join("  "),
    );
  }
  return lines;
}

export function formatArtifactShow(record: ArtifactRecord): string {
  const source = [
    record.source.run_id ?? "-",
    record.source.stage_id ?? "-",
    record.source.attempt === null ? null : `attempt ${record.source.attempt}`,
  ]
    .filter((part) => part !== null)
    .join(" ");
  const lines = [
    `key: ${publicArtifactKey(ownerKeyFromRecord(record), record.id)}`,
    `title: ${record.title}`,
    `kind: ${record.kind}`,
    `status: ${record.status}`,
    ...(record.live
      ? [
          `live: ${liveStatusMarker(record) || "LIVE"}`,
          `last refreshed: ${record.live.last_refreshed_at ?? "-"}`,
          `last error: ${record.live.last_error_code ?? "-"}`,
          `bindings: ${
            record.live.bindings.length === 0
              ? "-"
              : record.live.bindings.map((binding) => `${binding.id} ${binding.function} read-only`).join("; ")
          }`,
          `refresh: ${formatRefreshPolicy(record.live.refresh)}`,
        ]
      : []),
    `owner: ${ownerDisplayText(record.owner)}`,
    `source: ${source}`,
    `updated: ${formatUpdated(record.updated_at)}`,
  ];
  if (record.status === "expired") {
    const reason = record.expired_reason ?? "-";
    const at = record.expired_at ? ` at ${formatUpdated(record.expired_at)}` : "";
    lines.push(`expired: ${reason}${at}`);
  } else {
    lines.push(`expires: ${record.expires_at ?? "-"}`);
  }
  return lines.join("\n");
}

export function parseArtifactShowKey(key: string): { ownerKey: string; id: string } | undefined {
  const trimmed = key.trim();
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { ownerKey: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
}
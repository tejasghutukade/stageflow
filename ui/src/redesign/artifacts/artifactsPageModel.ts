import type {
  ArtifactListOrder,
  ArtifactListQueryParams,
  ArtifactListSort,
  ArtifactLiveStatus,
  ArtifactRecord,
} from "../../api/artifacts";
import { displayCatalogPath, runTaskLabel } from "../../catalog/displayCatalogPath";
import { runShortId } from "../../catalogJoin";
import { agentPath, artifactDetailPath } from "../../routes";

export const ARTIFACTS_EMPTY_TITLE = "No artifacts yet";

export const ARTIFACTS_EMPTY_BODY =
  "Artifacts show up here when a stage finishes successfully and lists files in its envelope. Only those declared deliverables are indexed. Tool-output spill files, agent-internal folders, and anything the artifact path guard denies stay on the run and do not appear in this list.";

export const ARTIFACTS_FILTERED_EMPTY_TITLE = "No matches";

export const ARTIFACTS_FILTERED_EMPTY_BODY =
  "No artifacts match the current filters. Try changing or clearing them.";

export type ArtifactListTab = "all" | "live" | "static" | "session";

export type ArtifactListFilterState = {
  tab: ArtifactListTab;
  kind: string;
  owner: string;
  tag: string;
  status: "" | "available" | "expired";
  sort: ArtifactListSort;
  order: ArtifactListOrder;
  q: string;
};

export const DEFAULT_ARTIFACT_LIST_FILTERS: ArtifactListFilterState = {
  tab: "all",
  kind: "",
  owner: "",
  tag: "",
  status: "",
  sort: "updated",
  order: "desc",
  q: "",
};

export type ArtifactStatusPillVariant = "ok" | "fail" | "needs" | "running" | "muted";

export type ArtifactStatusPill = {
  label: string;
  variant: ArtifactStatusPillVariant;
};

/** Select value for the unscoped list. The API is called without project_root. */
export const ALL_PROJECTS_SCOPE = "";

export type ArtifactProjectRoot = {
  project_root: string;
  kind: string;
  read_only: boolean;
  available?: boolean;
};

export type ArtifactScopeOption = {
  id: string;
  label: string;
};

export type ArtifactRunRef = {
  run_id: string;
  pipeline_id: string;
  task_id?: string;
  task_path?: string;
  project_root?: string;
};

export type ArtifactListRow = {
  key: string;
  title: string;
  kind: string;
  kindLabel: string;
  ownerLabel: string;
  ownerPath: string | null;
  runId: string | null;
  runLabel: string;
  updatedLabel: string;
  expired: boolean;
  expiredReason: string | null;
  statusPill: ArtifactStatusPill;
  expiryNote: string | null;
  unregistered: boolean;
  projectId: string;
  projectLabel: string;
  showProject: boolean;
  detailPath: string;
};

export type ArtifactCursorState = {
  records: ArtifactRecord[];
  nextCursor: string | null;
};

const KIND_LABELS: Record<string, string> = {
  "static.markdown": "Markdown",
  "static.image": "Image",
  "static.table": "Table",
  "static.text": "Text",
  "static.html": "HTML",
  "live.declarative": "Live",
  "live.html": "Live HTML",
};

export function artifactKindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

const EXPIRED_SHORT: Record<string, string> = {
  run_slimmed: "Cleaned up to save space",
  session_expired: "Session artifact expired",
  run_purged: "Run was purged",
  run_deleted: "Run was deleted",
  file_missing: "File is missing",
};

export function artifactExpiredShortReason(reason: string | null | undefined): string {
  const code = reason?.trim() ?? "";
  if (code.length === 0) return "Expired";
  return EXPIRED_SHORT[code] ?? code;
}

export function activeArtifactProjectWireId(roots: readonly ArtifactProjectRoot[]): string {
  const workspace = roots.find(
    (root) => root.kind === "workspace" && root.available !== false && !root.read_only,
  );
  if (workspace) return workspace.project_root;
  const writable = roots.find((root) => !root.read_only && root.available !== false);
  return writable?.project_root ?? "workspace";
}

export function artifactProjectLabel(projectId: string): string {
  if (projectId === "workspace") return "Workspace";
  return displayCatalogPath(projectId);
}

export function artifactProjectScopeOptions(
  roots: readonly ArtifactProjectRoot[],
  activeId: string,
): ArtifactScopeOption[] {
  const options: ArtifactScopeOption[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (id.length === 0 || seen.has(id)) return;
    seen.add(id);
    options.push({ id, label: artifactProjectLabel(id) });
  };
  push(activeId);
  for (const root of roots) {
    if (root.available === false) continue;
    push(root.project_root);
  }
  return [...options, { id: ALL_PROJECTS_SCOPE, label: "All projects" }];
}

export function artifactScopeQuery(scopeId: string): string | undefined {
  return scopeId === ALL_PROJECTS_SCOPE ? undefined : scopeId;
}

export function artifactListFiltersActive(filters: ArtifactListFilterState): boolean {
  if (filters.tab !== "all") return true;
  if (filters.kind.trim().length > 0) return true;
  if (filters.owner.trim().length > 0) return true;
  if (filters.tag.trim().length > 0) return true;
  if (filters.status.length > 0) return true;
  if (filters.sort !== DEFAULT_ARTIFACT_LIST_FILTERS.sort) return true;
  if (filters.order !== DEFAULT_ARTIFACT_LIST_FILTERS.order) return true;
  if (filters.q.trim().length > 0) return true;
  return false;
}

export function tabToListQuery(tab: ArtifactListTab): Pick<ArtifactListQueryParams, "live" | "kind" | "scope"> {
  if (tab === "live") return { live: true };
  if (tab === "static") return { kind: "static" };
  if (tab === "session") return { scope: "session" };
  return {};
}

export function artifactListFiltersToQuery(
  filters: ArtifactListFilterState,
): Omit<ArtifactListQueryParams, "cursor" | "limit" | "project_root"> {
  const tabQuery = tabToListQuery(filters.tab);
  const query: Omit<ArtifactListQueryParams, "cursor" | "limit" | "project_root"> = {
    sort: filters.sort,
    order: filters.order,
    ...tabQuery,
  };
  const kind = filters.kind.trim();
  if (kind.length > 0) query.kind = kind;
  if (filters.tab === "static" && !query.kind) query.kind = "static";
  const owner = filters.owner.trim();
  if (owner.length > 0) query.owner = owner;
  const tag = filters.tag.trim().toLowerCase();
  if (tag.length > 0) query.tag = tag;
  if (filters.status) query.status = filters.status;
  const q = filters.q.trim();
  if (q.length > 0) query.q = q;
  return query;
}

export function artifactMatchCountLabel(count: number): string {
  return count === 1 ? "1 match" : `${count} matches`;
}

export const ARTIFACT_SEARCH_QUERY_HINT = "Try letters or numbers";

export function artifactSearchQueryRejected(error: string | null | undefined): boolean {
  return typeof error === "string" && error.toLowerCase().includes("query has no searchable terms");
}

export function parseArtifactListFiltersFromHash(hash = window.location.hash): {
  filters: ArtifactListFilterState;
  projectRoot: string | null;
} {
  const stripped = hash.replace(/^#\/?/, "");
  const q = stripped.indexOf("?");
  if (q < 0 || stripped.slice(0, q) !== "artifacts") {
    return { filters: { ...DEFAULT_ARTIFACT_LIST_FILTERS }, projectRoot: null };
  }
  const params = new URLSearchParams(stripped.slice(q + 1));
  const tabRaw = params.get("tab");
  const tab: ArtifactListTab =
    tabRaw === "live" || tabRaw === "static" || tabRaw === "session" ? tabRaw : "all";
  const sortRaw = params.get("sort");
  const sort: ArtifactListSort =
    sortRaw === "title" || sortRaw === "size" ? sortRaw : "updated";
  const orderRaw = params.get("order");
  const order: ArtifactListOrder = orderRaw === "asc" ? "asc" : orderRaw === "desc" ? "desc" : "desc";
  const statusRaw = params.get("status");
  const status: ArtifactListFilterState["status"] =
    statusRaw === "available" || statusRaw === "expired" ? statusRaw : "";
  return {
    filters: {
      tab,
      kind: params.get("kind") ?? "",
      owner: params.get("owner") ?? "",
      tag: params.get("tag") ?? "",
      status,
      sort,
      order: sort === "title" && orderRaw == null ? "asc" : order,
      q: params.get("q") ?? "",
    },
    projectRoot: params.get("project_root"),
  };
}

export function artifactsListHashPath(
  filters: ArtifactListFilterState,
  projectRoot?: string,
): string {
  const params = new URLSearchParams();
  if (projectRoot && projectRoot.length > 0) params.set("project_root", projectRoot);
  if (filters.tab !== "all") params.set("tab", filters.tab);
  if (filters.kind.trim().length > 0) params.set("kind", filters.kind.trim());
  if (filters.owner.trim().length > 0) params.set("owner", filters.owner.trim());
  const tag = filters.tag.trim().toLowerCase();
  if (tag.length > 0) params.set("tag", tag);
  if (filters.status) params.set("status", filters.status);
  if (filters.q.trim().length > 0) params.set("q", filters.q.trim());
  if (filters.sort !== "updated" || filters.order !== "desc") {
    params.set("sort", filters.sort);
    params.set("order", filters.order);
  }
  const query = params.toString();
  return query.length > 0 ? `/artifacts?${query}` : "/artifacts";
}

export function replaceArtifactsListInHash(filters: ArtifactListFilterState, projectRoot?: string): void {
  const next = artifactsListHashPath(filters, projectRoot);
  if (window.location.hash.replace(/^#/, "") !== next) {
    window.location.hash = next;
  }
}

export function serializeArtifactListFiltersRoundTrip(
  filters: ArtifactListFilterState,
  projectRoot?: string,
): ArtifactListFilterState {
  const path = artifactsListHashPath(filters, projectRoot);
  const hash = `#${path}`;
  return parseArtifactListFiltersFromHash(hash).filters;
}

export type ArtifactExpiryNoteKind = "expires_today" | "expires_in" | "expired" | null;

export function artifactExpiryNote(expiresAt: string | null, now = Date.now()): string | null {
  if (expiresAt == null || expiresAt.trim() === "") return null;
  const end = Date.parse(expiresAt);
  if (!Number.isFinite(end)) return null;
  const dayMs = 86_400_000;
  const utcDay = (ms: number) => Math.floor(ms / dayMs);
  const today = utcDay(now);
  const expiryDay = utcDay(end);
  if (expiryDay < today) return "expired";
  if (expiryDay === today) return "expires today";
  const days = expiryDay - today;
  if (days === 1) return "expires tomorrow";
  return `expires in ${days} days`;
}

export function artifactIndexedStatusPill(record: Pick<ArtifactRecord, "status">): ArtifactStatusPill {
  if (record.status === "expired") {
    return { label: "Expired", variant: "fail" };
  }
  return { label: "Available", variant: "ok" };
}

export function artifactLiveStatusPill(status: ArtifactLiveStatus): ArtifactStatusPill {
  switch (status) {
    case "fresh":
      return { label: "Fresh", variant: "ok" };
    case "stale":
      return { label: "Stale", variant: "needs" };
    case "error":
      return { label: "Error", variant: "fail" };
    case "refreshing":
      return { label: "Refreshing", variant: "running" };
    default:
      return { label: String(status), variant: "muted" };
  }
}

export function artifactStatusPillForRecord(record: ArtifactRecord): ArtifactStatusPill {
  if (record.live) {
    if (record.live.status) return artifactLiveStatusPill(record.live.status);
    return { label: "Live", variant: "muted" };
  }
  return artifactIndexedStatusPill(record);
}

export function artifactStatusPillClass(variant: ArtifactStatusPillVariant): string {
  switch (variant) {
    case "ok":
      return "sf-pill sf-pill--ok";
    case "fail":
      return "sf-pill sf-pill--fail";
    case "needs":
      return "sf-pill sf-pill--needs";
    case "running":
      return "sf-pill sf-pill--running";
    default:
      return "sf-pill";
  }
}

export function artifactTabCountsFromRecords(
  records: readonly ArtifactRecord[],
): { all: number; live: number; static: number; session: number } {
  let live = 0;
  let staticCount = 0;
  let session = 0;
  for (const row of records) {
    if (row.scope === "session") session += 1;
    if (row.kind.startsWith("live.")) live += 1;
    else if (row.kind.startsWith("static.")) staticCount += 1;
  }
  return { all: records.length, live, static: staticCount, session };
}

export function initialArtifactCursorState(): ArtifactCursorState {
  return { records: [], nextCursor: null };
}

export function applyArtifactPage(
  state: ArtifactCursorState,
  page: { artifacts: readonly ArtifactRecord[]; next_cursor: string | null },
  mode: "replace" | "append",
): ArtifactCursorState {
  return {
    records: mode === "append" ? [...state.records, ...page.artifacts] : [...page.artifacts],
    nextCursor: page.next_cursor,
  };
}

export function artifactOwnerKey(owner: ArtifactRecord["owner"]): string {
  if (owner.kind === "agent") return `agent:${owner.agent}`;
  return `stage:${owner.pipeline}:${owner.stage}`;
}

export function artifactOwnerLabel(owner: ArtifactRecord["owner"]): string {
  if (owner.kind === "agent") return `agent · ${owner.agent}`;
  return `${owner.pipeline} / ${owner.stage}`;
}

/** Agent page path when the owner is an agent. Pass known ids to omit the link after the agent is gone. */
export function artifactOwnerPath(
  owner: ArtifactRecord["owner"],
  knownAgentIds?: ReadonlySet<string>,
): string | null {
  if (owner.kind !== "agent") return null;
  if (knownAgentIds !== undefined && !knownAgentIds.has(owner.agent)) return null;
  return agentPath(owner.agent);
}

export function formatArtifactUpdated(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const minutes = Math.floor(Math.max(0, now - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function artifactRunLabel(
  runId: string | null,
  runs?: ReadonlyMap<string, ArtifactRunRef>,
): string {
  if (!runId) return "—";
  const run = runs?.get(runId);
  if (!run) return runShortId(runId);
  const task = runTaskLabel(run);
  const short = runShortId(runId);
  if (!task || task === short) return short;
  return `${short} · ${task}`;
}

export function artifactListRows(
  records: readonly ArtifactRecord[],
  now = Date.now(),
  options?: { runs?: ReadonlyMap<string, ArtifactRunRef>; showProject?: boolean; knownAgentIds?: ReadonlySet<string> },
): ArtifactListRow[] {
  const showProject = options?.showProject === true;
  return records.map((record) => ({
    key: `${record.project.id}\0${record.key}`,
    title: record.title,
    kind: record.kind,
    kindLabel: artifactKindLabel(record.kind),
    ownerLabel: artifactOwnerLabel(record.owner),
    ownerPath: artifactOwnerPath(record.owner, options?.knownAgentIds),
    runId: record.source.run_id,
    runLabel: artifactRunLabel(record.source.run_id, options?.runs),
    updatedLabel: formatArtifactUpdated(record.updated_at, now),
    expired: record.status === "expired",
    expiredReason: record.status === "expired" ? artifactExpiredShortReason(record.expired_reason) : null,
    statusPill: artifactStatusPillForRecord(record),
    expiryNote: artifactExpiryNote(record.expires_at, now),
    unregistered: record.project.registered === false,
    projectId: record.project.id,
    projectLabel: artifactProjectLabel(record.project.id),
    showProject,
    detailPath: artifactDetailPath(artifactOwnerKey(record.owner), record.id, record.project.id),
  }));
}

export function unregisteredProjectLabel(row: Pick<ArtifactListRow, "unregistered" | "projectId">): string | null {
  if (!row.unregistered) return null;
  return `Unregistered project ${row.projectId}`;
}

import type { ArtifactRecord } from "../../api/artifacts";
import { displayCatalogPath, runTaskLabel } from "../../catalog/displayCatalogPath";
import { runShortId } from "../../catalogJoin";

export const ARTIFACTS_EMPTY_TITLE = "No artifacts yet";

export const ARTIFACTS_EMPTY_BODY =
  "Artifacts show up here when a stage finishes successfully and lists files in its envelope. Only those declared deliverables are indexed. Tool-output spill files, agent-internal folders, and anything the artifact path guard denies stay on the run and do not appear in this list.";

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
  runId: string | null;
  runLabel: string;
  updatedLabel: string;
  unregistered: boolean;
  projectId: string;
  projectLabel: string;
  showProject: boolean;
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

export function artifactOwnerLabel(owner: ArtifactRecord["owner"]): string {
  if (owner.kind === "agent") return owner.agent;
  return `${owner.pipeline} / ${owner.stage}`;
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
  options?: { runs?: ReadonlyMap<string, ArtifactRunRef>; showProject?: boolean },
): ArtifactListRow[] {
  const showProject = options?.showProject === true;
  return records.map((record) => ({
    key: `${record.project.id}\0${record.key}`,
    title: record.title,
    kind: record.kind,
    kindLabel: artifactKindLabel(record.kind),
    ownerLabel: artifactOwnerLabel(record.owner),
    runId: record.source.run_id,
    runLabel: artifactRunLabel(record.source.run_id, options?.runs),
    updatedLabel: formatArtifactUpdated(record.updated_at, now),
    unregistered: record.project.registered === false,
    projectId: record.project.id,
    projectLabel: artifactProjectLabel(record.project.id),
    showProject,
  }));
}

export function unregisteredProjectLabel(row: Pick<ArtifactListRow, "unregistered" | "projectId">): string | null {
  if (!row.unregistered) return null;
  return `Unregistered project ${row.projectId}`;
}

import {
  normalizeDraftCatalogFilenames,
  normalizePipelineCatalogFilename,
} from "@stageflow/workshop-catalog-filenames";
import type {
  CatalogRoot,
  CatalogRootKind,
  DraftPackagePayload,
  PlanDraftPackageInput,
} from "../../api";
import { attachmentMetaList } from "./chat/attachments";
import { stageChangeStatus } from "./graph/workshopGraphModel";
import { setPipelineId } from "./inspector/stageFields";

export const AUTOSAVE_DEBOUNCE_MS = 2000;

export const WORKSHOP_CHAT_DEFAULT_WIDTH = 384;
export const WORKSHOP_CHAT_MIN_WIDTH = 300;
export const WORKSHOP_CHAT_MAX_WIDTH = 560;

export const CREATE_TASK_PREFILL = "Create a task for this pipeline: ";

export const WORKSHOP_ATTACHMENT_CHIPS = "workshop-attachment-chips";

export type WorkshopSaveState = "new" | "dirty" | "clean";

export type WorkshopBootTarget = "package" | "session";

export type SaveDialogMode = "create" | "overwrite";

export type SaveIntent =
  | { kind: "overwrite-direct" }
  | { kind: "dialog"; mode: SaveDialogMode; allowInvalidInitial: boolean };

export type FolderOption = { value: string; label: string };

export const DEFAULT_WRITE_CATALOG_WIRE_ID = "workspace";

export type DraftOrigin = {
  project_root: string;
  kind: CatalogRootKind;
  readOnly: boolean;
};

export type WritableRootOption = {
  value: string;
  label: string;
  available: boolean;
  unavailableReason?: string;
};

export type AttachmentChip = { name: string; size: number; mediaType: string };

export function clampWorkshopChatWidth(width: number): number {
  return Math.max(
    WORKSHOP_CHAT_MIN_WIDTH,
    Math.min(WORKSHOP_CHAT_MAX_WIDTH, width),
  );
}

export function workshopChangeCount(
  draft: DraftPackagePayload,
  baseline: DraftPackagePayload | null,
): number {
  let count = 0;
  for (const status of stageChangeStatus(draft, baseline).values()) {
    if (status !== "unchanged") count += 1;
  }
  return count;
}

export function workshopSaveState(
  savedPipelinePath: string | null | undefined,
  changeCount: number,
): WorkshopSaveState {
  if (!savedPipelinePath) return "new";
  if (changeCount === 0) return "clean";
  return "dirty";
}

export function workshopBootTarget(
  pipelinePath: string | undefined,
): WorkshopBootTarget {
  return pipelinePath ? "package" : "session";
}

export function projectRootField(
  projectRoot: string | undefined,
): { project_root?: string } {
  return projectRoot ? { project_root: projectRoot } : {};
}

export function draftOriginFromResponse(input: {
  project_root?: string;
  root_kind?: CatalogRootKind;
  read_only?: boolean;
}): DraftOrigin | null {
  const project_root = input.project_root?.trim();
  if (!project_root) return null;
  return {
    project_root,
    kind: input.root_kind ?? "registered",
    readOnly: input.read_only === true,
  };
}

export function fallbackDraftOrigin(): DraftOrigin {
  return {
    project_root: DEFAULT_WRITE_CATALOG_WIRE_ID,
    kind: "workspace",
    readOnly: false,
  };
}

export function defaultWritableRootWireId(roots: readonly CatalogRoot[]): string {
  const workspace = roots.find(
    (root) => root.kind === "workspace" && root.available !== false && !root.read_only,
  );
  if (workspace) return workspace.project_root;
  const writable = roots.find(
    (root) => !root.read_only && root.available !== false,
  );
  return writable?.project_root ?? DEFAULT_WRITE_CATALOG_WIRE_ID;
}

export function writableRootOptions(roots: readonly CatalogRoot[]): WritableRootOption[] {
  return roots
    .filter((root) => !root.read_only)
    .map((root) => ({
      value: root.project_root,
      label: root.label,
      available: root.available !== false,
      ...(root.unavailable_reason ? { unavailableReason: root.unavailable_reason } : {}),
    }));
}

export function omitDefaultWriteProjectRoot(
  chosenWireId: string | undefined,
  defaultWireId: string,
): { project_root?: string } {
  const chosen = chosenWireId?.trim();
  const fallback = defaultWireId.trim() || DEFAULT_WRITE_CATALOG_WIRE_ID;
  if (!chosen || chosen === fallback) return {};
  return { project_root: chosen };
}

export function defaultPackageDirectory(
  rootKind: CatalogRootKind | undefined,
  pipelineId: string,
): string {
  const id = pipelineId.trim() || "untitled";
  if (rootKind === "workspace") return id;
  return `workshop/${id}`;
}

export function folderOptionsForSave(
  rootKind: CatalogRootKind | undefined,
  pipelineId: string,
  existingFolder?: string,
): FolderOption[] {
  const seen = new Set<string>();
  const options: FolderOption[] = [];
  const add = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    options.push({ value: trimmed, label: trimmed });
  };
  add(defaultPackageDirectory(rootKind, pipelineId));
  if (existingFolder) add(existingFolder);
  return options;
}

export function packageReadProjectRoot(origin: DraftOrigin | null | undefined): string | undefined {
  return origin?.project_root;
}

export function openDraftInput(input: {
  path: string;
  task?: string;
  projectRoot?: string;
}): { path: string; task?: string; project_root?: string } {
  return {
    path: input.path,
    ...(input.task ? { task: input.task } : {}),
    ...projectRootField(input.projectRoot),
  };
}

function normalizeCatalogPathForMatch(pathValue: string): string {
  return pathValue.trim().replace(/\\/g, "/");
}

export function projectRootForPipelinePath(
  pipelines: ReadonlyArray<{ project_root?: string; path?: string }>,
  pipelinePath: string,
): string | undefined {
  const target = normalizeCatalogPathForMatch(pipelinePath);
  if (!target) return undefined;
  const matches = pipelines.filter(
    (pipeline) =>
      pipeline.path &&
      normalizeCatalogPathForMatch(pipeline.path) === target,
  );
  const roots = [
    ...new Set(
      matches
        .map((pipeline) => pipeline.project_root?.trim())
        .filter((root): root is string => Boolean(root)),
    ),
  ];
  return roots.length === 1 ? roots[0] : undefined;
}

export function saveIntentForOrigin(input: {
  hasDestination: boolean;
  errorCount: number;
  invalid?: boolean;
  originReadOnly?: boolean;
}): SaveIntent {
  if (input.originReadOnly) {
    return {
      kind: "dialog",
      mode: "create",
      allowInvalidInitial: Boolean(input.invalid),
    };
  }
  return saveIntent(input);
}

export function saveIntent(input: {
  hasDestination: boolean;
  errorCount: number;
  invalid?: boolean;
}): SaveIntent {
  if (input.invalid) {
    return {
      kind: "dialog",
      mode: input.hasDestination ? "overwrite" : "create",
      allowInvalidInitial: true,
    };
  }
  if (input.hasDestination && input.errorCount === 0) {
    return { kind: "overwrite-direct" };
  }
  return {
    kind: "dialog",
    mode: input.hasDestination ? "overwrite" : "create",
    allowInvalidInitial: false,
  };
}

export function saveAsIntent(): SaveIntent {
  return {
    kind: "dialog",
    mode: "create",
    allowInvalidInitial: false,
  };
}

export function pipelineFilenameFor(
  pipelineId: string,
  current: { id: string; filename?: string | null },
): string {
  const id = pipelineId.trim() || "untitled";
  const keepFilename =
    current.filename && current.id === id ? current.filename : null;
  return normalizePipelineCatalogFilename(id, keepFilename);
}

export function draftWithCatalogFilenames(
  draft: DraftPackagePayload,
): DraftPackagePayload {
  return normalizeDraftCatalogFilenames(draft).draft;
}

export function planDraftInput(input: {
  destination: { folder: string; pipelineId: string };
  draft: DraftPackagePayload;
  mode: SaveDialogMode;
  projectRoot?: string;
  defaultWriteWireId?: string;
  filename?: string | null;
}): PlanDraftPackageInput {
  const pipelineId = input.destination.pipelineId.trim() || input.draft.pipeline.id;
  const draftBeforeNames =
    pipelineId === input.draft.pipeline.id
      ? input.draft
      : setPipelineId(input.draft, pipelineId);
  const { draft, pipelineFilename } = normalizeDraftCatalogFilenames(
    draftBeforeNames,
    pipelineFilenameFor(pipelineId, {
      id: input.draft.pipeline.id,
      filename: input.filename,
    }),
  );
  return {
    directory: input.destination.folder,
    draft,
    pipelineFilename,
    mode: input.mode,
    ...omitDefaultWriteProjectRoot(
      input.projectRoot,
      input.defaultWriteWireId ?? DEFAULT_WRITE_CATALOG_WIRE_ID,
    ),
  };
}

export function savedFileCount(result: {
  stagePaths: readonly string[];
  taskPath?: string;
}): number {
  return 1 + result.stagePaths.length + (result.taskPath ? 1 : 0);
}

export function mergeTaskFromAuthoritativeDraft(
  local: DraftPackagePayload,
  authoritative: DraftPackagePayload | null | undefined,
): DraftPackagePayload {
  if (local.task || !authoritative?.task) return local;
  return { ...local, task: authoritative.task };
}

export async function draftForWorkshopSave(input: {
  draft: DraftPackagePayload;
  buildId: string | null;
  loadBuild: (
    buildId: string,
  ) => Promise<
    | { ok: true; build: { draft: DraftPackagePayload } }
    | { ok: false; error: string }
  >;
  resolveActiveBuildId?: () => Promise<string | null>;
}): Promise<{
  draft: DraftPackagePayload;
  mergedTaskFromServer: boolean;
  adoptedBuildId: string | null;
}> {
  let draft = input.draft;
  let mergedTaskFromServer = false;
  let adoptedBuildId: string | null = null;

  if (draft.task) {
    return { draft, mergedTaskFromServer, adoptedBuildId };
  }

  let targetBuildId = input.buildId;
  if (!targetBuildId && input.resolveActiveBuildId) {
    targetBuildId = await input.resolveActiveBuildId();
  }
  if (!targetBuildId) {
    return { draft, mergedTaskFromServer, adoptedBuildId };
  }

  const loaded = await input.loadBuild(targetBuildId);
  if (!loaded.ok) {
    return { draft, mergedTaskFromServer, adoptedBuildId };
  }

  const merged = mergeTaskFromAuthoritativeDraft(draft, loaded.build.draft);
  if (merged !== draft) {
    draft = merged;
    mergedTaskFromServer = true;
  }
  if (!input.buildId) {
    adoptedBuildId = targetBuildId;
  }
  return { draft, mergedTaskFromServer, adoptedBuildId };
}

export function mutationCardOnRegister(
  auto: boolean,
  at: number,
): { status: "pending"; at: number; auto?: true } {
  return auto ? { status: "pending", auto: true, at } : { status: "pending", at };
}

export function latestPendingMutationId(
  cards: ReadonlyMap<string, { status: string; at?: number }>,
): string | null {
  let latestId: string | null = null;
  let latestAt = -Infinity;
  let index = 0;
  for (const [id, card] of cards) {
    if (card.status !== "pending") {
      index += 1;
      continue;
    }
    const at = card.at ?? index;
    if (latestId === null || at >= latestAt) {
      latestId = id;
      latestAt = at;
    }
    index += 1;
  }
  return latestId;
}

export function attachmentChipsFromAutosave(message: {
  attachments?: unknown;
  artifacts?: unknown;
}): AttachmentChip[] {
  const direct = attachmentMetaList(message.attachments);
  if (direct.length > 0) return direct;
  const artifacts = message.artifacts;
  if (
    artifacts &&
    typeof artifacts === "object" &&
    !Array.isArray(artifacts) &&
    (artifacts as { kind?: unknown }).kind === WORKSHOP_ATTACHMENT_CHIPS
  ) {
    return attachmentMetaList((artifacts as { attachments?: unknown }).attachments);
  }
  return [];
}

export function seedTranscriptFromAutosave(
  messages: ReadonlyArray<{
    role: string;
    text: string;
    createdAt?: string;
    attachments?: unknown;
    artifacts?: unknown;
  }>,
): Array<{
  role: string;
  text: string;
  createdAt?: string;
  attachments?: AttachmentChip[];
}> {
  return messages.map((message) => {
    const attachments = attachmentChipsFromAutosave(message);
    return {
      role: message.role,
      text: message.text,
      ...(message.createdAt ? { createdAt: message.createdAt } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  });
}

export function autosaveArtifactsForAttachments(
  attachments: readonly AttachmentChip[],
): { kind: typeof WORKSHOP_ATTACHMENT_CHIPS; attachments: AttachmentChip[] } | undefined {
  if (attachments.length === 0) return undefined;
  return {
    kind: WORKSHOP_ATTACHMENT_CHIPS,
    attachments: attachments.map((item) => ({
      name: item.name,
      size: item.size,
      mediaType: item.mediaType,
    })),
  };
}

export function askAgentToFixPrompt(location: string, message: string): string {
  return `Fix this validation error in ${location}: ${message}`;
}

export function initialDrawerTab(draft: {
  pipeline: { stages: readonly unknown[] };
  task?: unknown;
}): "task" | "problems" {
  if (draft.pipeline.stages.length === 0 && !draft.task) return "task";
  return "problems";
}

export function escapeWorkshopAction(input: {
  bannerVisible: boolean;
  selectedStageId: string | null;
}): "dismiss-banner" | "clear-selection" | "none" {
  if (input.bannerVisible) return "dismiss-banner";
  if (input.selectedStageId) return "clear-selection";
  return "none";
}

import {
  normalizeDraftCatalogFilenames,
  normalizePipelineCatalogFilename,
} from "@stageflow/workshop-catalog-filenames";
import type {
  CatalogRoot,
  CatalogRootKind,
  DraftPackagePayload,
  PlanDraftPackageInput,
  WorkshopChatProposalPayload,
  WorkshopSessionMutationSnapshot,
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

export type SaveIntent = {
  kind: "dialog";
  mode: SaveDialogMode;
  allowInvalidInitial: boolean;
};

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

export function workshopPrimarySaveDisabled(input: {
  stageCount: number;
  saving: boolean;
  hasDestination: boolean;
  saveState: WorkshopSaveState;
}): boolean {
  if (input.stageCount === 0 || input.saving) return true;
  return input.hasDestination && input.saveState === "clean";
}

/** Session wins when both `?session=` and `?pipeline=` are present (W3). */
export function workshopBootTarget(input: {
  sessionId?: string | null;
  pipelinePath?: string | null;
}): WorkshopBootTarget {
  if (input.sessionId?.trim()) return "session";
  if (input.pipelinePath?.trim()) return "package";
  return "session";
}

/** New chat / session restore: no package identity in the URL (W1). */
export function workshopUrlAfterNewChat(): {
  session?: undefined;
  pipeline?: undefined;
  task?: undefined;
  project_root?: undefined;
} {
  return {};
}

/** Session restore strips package params so refresh stays on the chat (W3). */
export function workshopUrlAfterSession(sessionId: string): { session: string } {
  return { session: sessionId };
}

/** Intentional package open keeps pipeline identity, never a session (W1/W3). */
export function workshopUrlAfterPackageOpen(input: {
  pipeline: string;
  task?: string;
  projectRoot?: string;
}): { pipeline: string; task?: string; project_root?: string } {
  return {
    pipeline: input.pipeline,
    ...(input.task ? { task: input.task } : {}),
    ...(input.projectRoot ? { project_root: input.projectRoot } : {}),
  };
}

/** Cleared disk-change baseline used on New chat and package switch (W10). */
export function emptyDiskChangeState(): {
  fingerprints: Record<string, string>;
  changedPaths: string[];
  showBanner: false;
} {
  return { fingerprints: {}, changedPaths: [], showBanner: false };
}

/**
 * First message after an ephemeral package open should focus/create the tied
 * build before the agent runs (W2/W6). Returns null when a build is already
 * selected or no package is open.
 */
export function packageFocusInputForChat(input: {
  selectedBuildId: string | null;
  savedPipelinePath: string | null | undefined;
  projectRoot: string | null | undefined;
}): { projectRoot: string; relativePath: string } | null {
  if (input.selectedBuildId) return null;
  const relativePath = input.savedPipelinePath?.trim();
  const projectRoot = input.projectRoot?.trim();
  if (!relativePath || !projectRoot) return null;
  return { projectRoot, relativePath };
}

/** Bump a studio request generation so only the latest async pick/boot applies (W11). */
export function nextStudioGeneration(ref: { current: number }): number {
  ref.current += 1;
  return ref.current;
}

export function studioGenerationIsCurrent(
  captured: number,
  ref: { current: number },
): boolean {
  return ref.current === captured;
}

/** Identity of a package open. The workshop session id is not part of it. */
export function workshopPackageBootKey(
  pipelinePath: string,
  taskPath?: string,
  projectRoot?: string,
): string {
  return `${projectRoot ?? ""}\0${pipelinePath}\0${taskPath ?? ""}`;
}

/** A session id written into the URL after boot is the same open, not a new one. */
export function shouldBootWorkshopPackage(
  openKey: string | null,
  pipelinePath: string | undefined,
  taskPath?: string,
  projectRoot?: string,
): boolean {
  if (!pipelinePath) return false;
  return openKey !== workshopPackageBootKey(pipelinePath, taskPath, projectRoot);
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

/** Prefer open API origin; else catalog root metadata (never assume writable). */
export function draftOriginFromCatalogRoot(
  roots: readonly CatalogRoot[],
  projectRoot: string | null | undefined,
): DraftOrigin | null {
  const target = projectRoot?.trim();
  if (!target) return null;
  const root = roots.find((item) => item.project_root === target);
  if (!root) return null;
  return {
    project_root: root.project_root,
    kind: root.kind,
    readOnly: root.read_only === true,
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
  return {
    kind: "dialog",
    mode: input.hasDestination ? "overwrite" : "create",
    allowInvalidInitial: Boolean(input.invalid),
  };
}

export function saveAsIntent(): SaveIntent {
  return {
    kind: "dialog",
    mode: "create",
    allowInvalidInitial: false,
  };
}

export type CatalogSaveBinding = {
  savedPipelinePath: string;
  saveDestination: { directory: string; pipelineFilename: string };
};

export type RehydratedMutationCard = {
  proposal: WorkshopChatProposalPayload;
  status: "accepted" | "rejected";
  auto?: boolean;
  at: number;
};

export function emptyDraftPackage(): DraftPackagePayload {
  return { pipeline: { id: "untitled", stages: [] } };
}

function draftFromSnapshot(
  draft: DraftPackagePayload | undefined,
): DraftPackagePayload {
  return draft ? structuredClone(draft) : emptyDraftPackage();
}

export function proposalFromMutationSnapshot(
  snapshot: WorkshopSessionMutationSnapshot,
): WorkshopChatProposalPayload {
  return {
    id: snapshot.id,
    summary: snapshot.summary,
    affectedStageIds: [...snapshot.affectedStageIds],
    artifacts: snapshot.artifacts.map((artifact) => ({ ...artifact })),
    baseDraft: draftFromSnapshot(snapshot.baseDraft),
    nextDraft: draftFromSnapshot(snapshot.nextDraft),
    baseFingerprint: snapshot.baseFingerprint || snapshot.id,
  };
}

export function settledMutationCardsFromTranscript(
  transcript: readonly { mutations?: readonly WorkshopSessionMutationSnapshot[] }[],
): Map<string, RehydratedMutationCard> {
  const map = new Map<string, RehydratedMutationCard>();
  let at = 0;
  for (const message of transcript) {
    for (const mutation of message.mutations ?? []) {
      map.set(mutation.id, {
        proposal: proposalFromMutationSnapshot(mutation),
        status: mutation.status,
        ...(mutation.autoApplied ? { auto: true } : {}),
        at,
      });
      at += 1;
    }
  }
  return map;
}

export function catalogSaveBindingFromRelativePath(
  relativePath: string,
  pipelineId: string,
): CatalogSaveBinding | null {
  const trimmed = relativePath.trim().replace(/\\/g, "/");
  if (!trimmed) return null;
  const segments = trimmed.split("/");
  const leaf = segments.pop();
  if (!leaf) return null;
  const directory = segments.join("/") || ".";
  const pipelineFilename = pipelineFilenameFor(pipelineId, {
    id: pipelineId,
    filename: leaf,
  });
  return {
    savedPipelinePath: trimmed,
    saveDestination: { directory, pipelineFilename },
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

import type { DraftPackagePayload, PlanDraftPackageInput } from "../../api";
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

export type CatalogRoot = { value: string; label: string };

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

export function catalogRoots(
  pipelines: ReadonlyArray<{ project_root?: string }>,
): CatalogRoot[] {
  const seen = new Set<string>();
  const roots: CatalogRoot[] = [];
  for (const pipeline of pipelines) {
    const root = pipeline.project_root?.trim();
    if (!root || seen.has(root)) continue;
    seen.add(root);
    roots.push({ value: root, label: root });
  }
  if (roots.length === 0) return [{ value: ".", label: "." }];
  return roots;
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
  if (current.filename && current.id === id) return current.filename;
  return `${id}.yaml`;
}

export function planDraftInput(input: {
  destination: { root: string; pipelineId: string };
  draft: DraftPackagePayload;
  mode: SaveDialogMode;
  projectRoot?: string;
  filename?: string | null;
}): PlanDraftPackageInput {
  const pipelineId = input.destination.pipelineId.trim() || input.draft.pipeline.id;
  const draft =
    pipelineId === input.draft.pipeline.id
      ? input.draft
      : setPipelineId(input.draft, pipelineId);
  return {
    directory: input.destination.root,
    draft,
    pipelineFilename: pipelineFilenameFor(pipelineId, {
      id: input.draft.pipeline.id,
      filename: input.filename,
    }),
    mode: input.mode,
    ...projectRootField(input.projectRoot),
  };
}

export function savedFileCount(result: {
  stagePaths: readonly string[];
  taskPath?: string;
}): number {
  return 1 + result.stagePaths.length + (result.taskPath ? 1 : 0);
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

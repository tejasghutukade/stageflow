import path from "node:path";
import type { DraftPackage } from "../config/draftPackage.js";
import { isWorkshopDraftContext } from "../operatorAgent/draftContext.js";
import type {
  OperatorAgentToolResult,
  WorkshopDraftContext,
} from "../operatorAgent/types.js";
import {
  createWorkshopBuild,
  getWorkshopBuild,
  readWorkshopBuild,
  updateWorkshopBuild,
  type WorkshopBuildRecord,
} from "./buildStore.js";
import { updateWorkshopSessionActiveBuildId } from "./sessionStore.js";

export const WORKSHOP_UNLINKED_DRAFT_TOOL_ERROR =
  "No build is selected — draft tools cannot edit or save until a build is focused.";

const WORKSHOP_DRAFT_TOOL_NAMES = new Set([
  "read_draft",
  "validate_draft",
  "create_pipeline",
  "edit_pipeline",
  "create_stage",
  "edit_stage",
  "create_task",
  "edit_task",
  "save",
  "propose_draft",
]);

export type WorkshopPointerChange = {
  buildId: string;
  draft: DraftPackage;
};

export type WorkshopPinRegistry = {
  get(sessionId: string):
    | {
        getContext(): unknown;
        setContext(next: unknown): void;
      }
    | undefined;
  getPinnedBuildId(sessionId: string): string | null;
  setPinnedBuildId(sessionId: string, buildId: string | null): void;
  getLiveTurn(sessionId: string):
    | {
        onPointerChange?: (frame: WorkshopPointerChange) => void;
      }
    | undefined;
};

const sessionWriteTails = new Map<string, Promise<void>>();
const liveBySession = new Map<
  string,
  { storeRoot: string; registry: WorkshopPinRegistry }
>();

export function enqueueSessionWrite<T>(sessionId: string, fn: () => T): Promise<T> {
  const prev = sessionWriteTails.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  sessionWriteTails.set(
    sessionId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function registerLiveWorkshopSession(
  sessionId: string,
  live: { storeRoot: string; registry: WorkshopPinRegistry },
): void {
  liveBySession.set(sessionId, live);
}

export function unregisterLiveWorkshopSession(sessionId: string): void {
  liveBySession.delete(sessionId);
}

export function resetWorkshopPinStateForTests(): void {
  sessionWriteTails.clear();
  liveBySession.clear();
}

function destinationFromRelativePath(relativePath: string): {
  directory: string;
  pipelineFilename: string;
} {
  const normalized = relativePath.replace(/\\/g, "/");
  const pipelineFilename = path.posix.basename(normalized);
  const dir = path.posix.dirname(normalized);
  return {
    directory: dir === "." ? "." : dir,
    pipelineFilename,
  };
}

function relativePathFromDestination(
  directory: string,
  pipelineFilename: string,
): string {
  const dir = directory.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const file = path.posix.basename(pipelineFilename.trim().replace(/\\/g, "/"));
  if (!dir || dir === ".") return file;
  return `${dir.replace(/\/+$/, "")}/${file}`;
}

export function bindPinnedBuildContext(
  current: unknown,
  build: WorkshopBuildRecord,
  sessionId: string,
): WorkshopDraftContext {
  const base: WorkshopDraftContext = isWorkshopDraftContext(current)
    ? { ...current }
    : { draft: build.draft };
  const next: WorkshopDraftContext = {
    ...base,
    draft: build.draft,
    chatSessionId: sessionId,
    buildId: build.id,
  };
  if (build.projectRoot) next.projectRoot = build.projectRoot;
  else delete next.projectRoot;
  if (build.projectRoot && build.relativePath) {
    next.destination = destinationFromRelativePath(build.relativePath);
  } else {
    delete next.destination;
  }
  return next;
}

function emitPointerChange(
  registry: WorkshopPinRegistry,
  sessionId: string,
  build: WorkshopBuildRecord,
): void {
  registry.getLiveTurn(sessionId)?.onPointerChange?.({
    buildId: build.id,
    draft: build.draft,
  });
}

function movePinOntoBuild(
  registry: WorkshopPinRegistry,
  sessionId: string,
  build: WorkshopBuildRecord,
  storeRoot: string,
): void {
  const session = registry.get(sessionId);
  if (session) {
    session.setContext(
      bindPinnedBuildContext(session.getContext(), build, sessionId),
    );
  }
  registry.setPinnedBuildId(sessionId, build.id);
  enqueueSessionWrite(sessionId, () => {
    updateWorkshopSessionActiveBuildId(storeRoot, sessionId, build.id);
  });
  emitPointerChange(registry, sessionId, build);
}

export function resolveLiveWorkshopBinding(context: unknown): {
  sessionId: string;
  registry: WorkshopPinRegistry;
  storeRoot: string;
} | null {
  if (!isWorkshopDraftContext(context) || !context.chatSessionId) return null;
  const live = liveBySession.get(context.chatSessionId);
  if (!live) return null;
  return {
    sessionId: context.chatSessionId,
    registry: live.registry,
    storeRoot: live.storeRoot,
  };
}

/**
 * Draft tools call this. Outside a workshop chat turn it does nothing.
 * An unlinked chat turn fails the tool and does not create a build.
 */
export function rejectUnlinkedWorkshopDraftTool(
  context: unknown,
  toolName: string,
): OperatorAgentToolResult | null {
  if (!WORKSHOP_DRAFT_TOOL_NAMES.has(toolName)) return null;
  if (!isWorkshopDraftContext(context) || !context.chatSessionId) return null;
  if (context.buildId) return null;
  return {
    ok: false,
    content: null,
    error: WORKSHOP_UNLINKED_DRAFT_TOOL_ERROR,
  };
}

/** Tied builds save to the stored path. Untitled builds keep the caller's destination. */
export function resolvePinnedSaveDestination(
  context: unknown,
): { directory: string; pipelineFilename: string } | null {
  if (
    !isWorkshopDraftContext(context) ||
    !context.buildId ||
    !context.chatSessionId
  ) {
    return null;
  }
  const live = liveBySession.get(context.chatSessionId);
  if (!live) return null;
  const build = readWorkshopBuild(live.storeRoot, context.buildId);
  if (!build?.projectRoot || !build.relativePath) return null;
  return destinationFromRelativePath(build.relativePath);
}

/** A successful save of an untitled build records the operator destination on that id. */
export function recordPinnedWorkshopSave(
  context: unknown,
  saved: {
    directory: string;
    pipelineFilename?: string;
    projectRoot: string;
    draft: DraftPackage;
  },
): void {
  if (
    !isWorkshopDraftContext(context) ||
    !context.buildId ||
    !context.chatSessionId
  ) {
    return;
  }
  const live = liveBySession.get(context.chatSessionId);
  if (!live) return;
  const build = readWorkshopBuild(live.storeRoot, context.buildId);
  if (!build || (build.projectRoot && build.relativePath)) return;
  const pipelineFilename =
    saved.pipelineFilename?.trim() ||
    `${saved.draft.pipeline.id}.pipeline.yaml`;
  updateWorkshopBuild(live.storeRoot, build.id, {
    draft: saved.draft,
    projectRoot: path.resolve(saved.projectRoot),
    relativePath: relativePathFromDestination(
      saved.directory,
      pipelineFilename,
    ),
  });
}

/**
 * Create an untitled build and move this turn's pin onto it.
 * Later edits in the turn persist on that id.
 */
export function pinWorkshopBuildOnCreate(input: {
  sessionId: string;
  draft: DraftPackage;
  registry: WorkshopPinRegistry;
  storeRoot: string;
}): WorkshopBuildRecord {
  const build = createWorkshopBuild(input.storeRoot, { draft: input.draft });
  registerLiveWorkshopSession(input.sessionId, {
    storeRoot: input.storeRoot,
    registry: input.registry,
  });
  movePinOntoBuild(input.registry, input.sessionId, build, input.storeRoot);
  return build;
}

/**
 * Focus a build. When this turn already has a pin, update the pointer only.
 * When the turn started with none, move the pin and the host onto that build.
 */
export function focusWorkshopBuildPointer(input: {
  sessionId: string;
  buildId: string;
  registry: WorkshopPinRegistry;
  storeRoot: string;
}): { pinMoved: boolean; activeBuildId: string } {
  const build = getWorkshopBuild(input.storeRoot, input.buildId);
  registerLiveWorkshopSession(input.sessionId, {
    storeRoot: input.storeRoot,
    registry: input.registry,
  });
  const pinned = input.registry.getPinnedBuildId(input.sessionId);
  const turnLive = input.registry.getLiveTurn(input.sessionId);
  const pinMoved = Boolean(turnLive) && !pinned;
  if (pinMoved) {
    movePinOntoBuild(
      input.registry,
      input.sessionId,
      build,
      input.storeRoot,
    );
  } else {
    enqueueSessionWrite(input.sessionId, () => {
      updateWorkshopSessionActiveBuildId(
        input.storeRoot,
        input.sessionId,
        build.id,
      );
    });
    if (turnLive) emitPointerChange(input.registry, input.sessionId, build);
  }
  return { pinMoved, activeBuildId: build.id };
}

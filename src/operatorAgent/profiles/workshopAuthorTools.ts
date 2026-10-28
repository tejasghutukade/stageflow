import path from "node:path";
import { Type } from "typebox";
import { peekDefaultModel } from "../../models/catalog.js";
import { parse as parseYaml } from "yaml";
import {
  CatalogPathError,
  resolveDefaultWriteRoot,
} from "../../config/catalogRelativePath.js";
import {
  validateDraftPackage,
  type DraftPackage,
} from "../../config/draftPackage.js";
import { defaultWorkshopPackageDirectory } from "../../config/ensureCatalogScanRoot.js";
import { canonicalizeNeedTerminalState } from "../../config/pipelineNeeds.js";
import { publishDraftPackage } from "../../config/publishDraftPackage.js";
import type { CatalogRootKind } from "../../config/resolveCatalogRoots.js";
import { globalStageflowHome } from "../../project/globalHome.js";
import {
  emptyDraftPackage,
  isWorkshopDraftContext,
  readDraftFromContext,
  withDraft,
} from "../draftContext.js";
import {
  focusUnboundWorkshopBuild,
  getWorkshopBuild,
  listWorkshopPickerRows,
  resolvePickerCatalogPipelines,
  type WorkshopPickerCatalogPipeline,
} from "../../workshop/buildStore.js";
import {
  focusWorkshopBuildPointer,
  pinWorkshopBuildOnCreate,
  recordPinnedWorkshopSave,
  resolveLiveWorkshopBinding,
  resolvePinnedSaveDestination,
} from "../../workshop/workshopPin.js";
import {
  affectedStageIds,
  diffDraftPackages,
  draftFingerprint,
} from "../proposals.js";
import type {
  OperatorAgentProposal,
  OperatorAgentTool,
  OperatorAgentToolContext,
  OperatorAgentToolResult,
  WorkshopDraftContext,
} from "../types.js";

export const WORKSHOP_AUTHOR_MUTATING_TOOLS = [
  "create_pipeline",
  "edit_pipeline",
  "create_stage",
  "edit_stage",
  "create_task",
  "edit_task",
] as const;

export const WORKSHOP_AUTHOR_TOOL_NAMES = [
  "list_builds",
  "focus_build",
  "create_build",
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
  "retrieve_docs",
] as const;

export const WORKSHOP_FORBIDDEN_AGENT_TOOLS = ["bash", "write", "edit"] as const;

const closed = { additionalProperties: false } as const;
const jsonObject = Type.Record(Type.String(), Type.Unknown());
const emptyParams = Type.Object({}, closed);


const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

let mutationSeq = 0;

function nextMutationId(): string {
  mutationSeq += 1;
  return `mutation-${mutationSeq}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function coercePlainObject(value: unknown): Record<string, unknown> | null {
  if (isPlainObject(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isPlainObject(parsed)) return parsed;
  } catch {}
  try {
    const parsed = parseYaml(trimmed) as unknown;
    if (isPlainObject(parsed)) return parsed;
  } catch {}
  return null;
}

function slugifyId(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || fallback;
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function applyMutation(
  ctx: OperatorAgentToolContext,
  summary: string,
  nextDraft: DraftPackage,
): OperatorAgentProposal {
  const current = readDraftFromContext(ctx.getContext());
  const proposal: OperatorAgentProposal = {
    id: nextMutationId(),
    summary,
    nextContext: nextDraft,
    baseContext: ctx.getContext(),
    baseFingerprint: draftFingerprint(current),
    artifacts: diffDraftPackages(current, nextDraft),
    affectedStageIds: affectedStageIds(current, nextDraft),
  };
  ctx.emitProposal(proposal);
  return proposal;
}

function readWorkshopContext(ctx: OperatorAgentToolContext): WorkshopDraftContext {
  const raw = ctx.getContext();
  if (isWorkshopDraftContext(raw)) return raw;
  return { draft: readDraftFromContext(raw) };
}

function resolveDestination(
  ctx: OperatorAgentToolContext,
  args: Record<string, unknown>,
  catalogRootKind?: CatalogRootKind,
): { directory: string; pipelineFilename?: string } | null {
  const directory =
    stringArg(args, "directory") ??
    readWorkshopContext(ctx).destination?.directory ??
    defaultWorkshopPackageDirectory(
      readDraftFromContext(ctx.getContext()).pipeline.id,
      catalogRootKind,
    );
  const pipelineFilename =
    stringArg(args, "pipelineFilename") ??
    stringArg(args, "pipeline_filename") ??
    readWorkshopContext(ctx).destination?.pipelineFilename;
  return pipelineFilename ? { directory, pipelineFilename } : { directory };
}

function resolveProjectRoot(
  ctx: OperatorAgentToolContext,
  defaultProjectRoot?: string,
): string | null {
  // Never trust LLM tool args for the write root — only host-bound context
  // (or the profile/host default passed into createSaveTool).
  return readWorkshopContext(ctx).projectRoot ?? defaultProjectRoot ?? null;
}

type SaveWriteTarget = {
  fsRoot: string;
  wireProjectRoot: string;
  catalogRootKind: CatalogRootKind;
};

async function resolveSaveWriteTarget(
  ctx: OperatorAgentToolContext,
  options: WorkshopAuthorToolOptions,
): Promise<{ ok: true; target: SaveWriteTarget } | { ok: false; error: string }> {
  const bound = resolveProjectRoot(ctx, options.projectRoot);
  const live = liveWorkshopBinding(ctx);
  const storeRoot = live?.storeRoot ?? globalStageflowHome();
  const { createRunStore } = await import("../../runstore/createStore.js");
  const store = createRunStore({ rootDir: storeRoot });
  try {
    if (bound) {
      try {
        const { wireRoot } = await resolveDefaultWriteRoot({ store }, bound);
        return {
          ok: true,
          target: {
            fsRoot: wireRoot.path,
            wireProjectRoot: wireRoot.project_root,
            catalogRootKind: wireRoot.kind,
          },
        };
      } catch (err) {
        if (
          err instanceof CatalogPathError &&
          err.code === "unknown_project_root"
        ) {
          const abs = path.resolve(bound);
          return {
            ok: true,
            target: {
              fsRoot: abs,
              wireProjectRoot: abs,
              catalogRootKind: "registered",
            },
          };
        }
        if (err instanceof CatalogPathError) {
          return { ok: false, error: err.message };
        }
        throw err;
      }
    }
    const { wireRoot } = await resolveDefaultWriteRoot({ store }, undefined);
    return {
      ok: true,
      target: {
        fsRoot: wireRoot.path,
        wireProjectRoot: wireRoot.project_root,
        catalogRootKind: wireRoot.kind,
      },
    };
  } catch (err) {
    if (err instanceof CatalogPathError) {
      return { ok: false, error: err.message };
    }
    throw err;
  } finally {
    await store.close();
  }
}

function normalizeRouteOnField(on: unknown): unknown {
  if (Array.isArray(on)) {
    return on.map((item) => canonicalizeNeedTerminalState(item) ?? item);
  }
  const one = canonicalizeNeedTerminalState(on);
  return one ?? on;
}

function normalizeRouteEntries(route: unknown): unknown {
  if (!Array.isArray(route)) return route;
  return route.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
    const rec = entry as Record<string, unknown>;
    if (rec.on === undefined) return entry;
    return { ...rec, on: normalizeRouteOnField(rec.on) };
  });
}

function isInlinePipelineStageBody(stage: Record<string, unknown>): boolean {
  return stage.system_prompt !== undefined || stage.uses === undefined;
}

function normalizePipelineStagesRouteOn(
  stages: DraftPackage["pipeline"]["stages"],
  options?: { ensureEntry?: boolean },
): DraftPackage["pipeline"]["stages"] {
  const next = stages.map((stage) => {
    if (!stage || typeof stage !== "object") return stage;
    let out: Record<string, unknown> = { ...stage };
    if (Array.isArray(out.route)) {
      out = {
        ...out,
        route: normalizeRouteEntries(out.route) as typeof stage.route,
      };
    }
    if (isInlinePipelineStageBody(out) && out.io === undefined) {
      out = { ...out, ...REQUIRED_IO };
    }
    return out;
  });
  if (
    options?.ensureEntry &&
    next.length > 0 &&
    !next.some((stage) => stage?.entry === true)
  ) {
    const first = next[0]!;
    next[0] = { ...first, entry: true };
  }
  return next;
}

export function buildCreateStageDraft(
  draft: DraftPackage,
  args: Record<string, unknown>,
): { ok: true; nextDraft: DraftPackage; stageId: string } | { ok: false; error: string } {
  const existingIds = new Set(
    draft.pipeline.stages.map((s) => (typeof s.id === "string" ? s.id : "")),
  );
  let stageId =
    stringArg(args, "id") ??
    slugifyId(stringArg(args, "summary") ?? stringArg(args, "label") ?? "stage", "stage");
  if (existingIds.has(stageId)) {
    stageId = `${stageId}-${existingIds.size + 1}`;
  }

  const usesPath =
    stringArg(args, "uses") ?? `./${stageId}.yaml`;
  const bodyFromArgs = coercePlainObject(args.body);
  if (
    typeof args.body === "string" &&
    args.body.trim() &&
    !bodyFromArgs
  ) {
    return { ok: false, error: "body must be a JSON or YAML object" };
  }
  const stageBody: Record<string, unknown> = {
    id: stageId,
    system_prompt:
      stringArg(args, "system_prompt") ??
      stringArg(args, "systemPrompt") ??
      `Stage for: ${stringArg(args, "summary") ?? stageId}`,
    model: stringArg(args, "model") ?? peekDefaultModel(),
    ...REQUIRED_IO,
    ...(bodyFromArgs ?? {}),
  };
  stageBody.id = stageId;
  const ioFromArgs = coercePlainObject(args.io);
  if (ioFromArgs) {
    stageBody.io = ioFromArgs;
  }

  const entry =
    typeof args.entry === "boolean"
      ? args.entry
      : draft.pipeline.stages.length === 0;

  const pipelineEntry: Record<string, unknown> = {
    id: stageId,
    uses: usesPath,
    ...(entry ? { entry: true } : {}),
  };
  if (Array.isArray(args.route)) {
    pipelineEntry.route = normalizeRouteEntries(args.route);
  }

  const nextDraft: DraftPackage = {
    ...draft,
    pipeline: {
      ...draft.pipeline,
      stages: [...draft.pipeline.stages, pipelineEntry],
    },
    stages: [...(draft.stages ?? []), { path: usesPath, body: stageBody }],
  };
  return { ok: true, nextDraft, stageId };
}

export function buildEditStageDraft(
  draft: DraftPackage,
  args: Record<string, unknown>,
): { ok: true; nextDraft: DraftPackage; stageId: string } | { ok: false; error: string } {
  const stageId = stringArg(args, "id");
  if (!stageId) {
    return { ok: false, error: "id is required" };
  }

  const pipelineIndex = draft.pipeline.stages.findIndex(
    (s) => typeof s.id === "string" && s.id === stageId,
  );
  if (pipelineIndex < 0) {
    return { ok: false, error: `stage not found: ${stageId}` };
  }

  const pipelineStages = draft.pipeline.stages.map((stage, index) => {
    if (index !== pipelineIndex) return { ...stage };
    const next = { ...stage };
    if (isPlainObject(args.pipeline_entry) || isPlainObject(args.pipelineEntry)) {
      Object.assign(
        next,
        (args.pipeline_entry as Record<string, unknown> | undefined) ??
          (args.pipelineEntry as Record<string, unknown>),
      );
      next.id = stageId;
    }
    if (typeof args.entry === "boolean") next.entry = args.entry;
    if (Array.isArray(args.route)) next.route = normalizeRouteEntries(args.route);
    if (stringArg(args, "uses")) next.uses = stringArg(args, "uses");
    return next;
  });

  const uses =
    typeof pipelineStages[pipelineIndex]!.uses === "string"
      ? (pipelineStages[pipelineIndex]!.uses as string)
      : `./${stageId}.yaml`;

  const existingArt = (draft.stages ?? []).find(
    (s) =>
      s.path.replace(/^\.\//, "") === uses.replace(/^\.\//, "") ||
      s.body.id === stageId,
  );
  const patch = isPlainObject(args.patch) ? args.patch : {};
  const bodyFromArgs = coercePlainObject(args.body);
  if (
    typeof args.body === "string" &&
    args.body.trim() &&
    !bodyFromArgs
  ) {
    return { ok: false, error: "body must be a JSON or YAML object" };
  }
  const nextBody: Record<string, unknown> = {
    ...(existingArt?.body ?? {
      id: stageId,
      system_prompt: `Stage ${stageId}`,
      model: peekDefaultModel(),
      ...REQUIRED_IO,
    }),
    ...patch,
    ...(bodyFromArgs ?? {}),
    id: stageId,
  };
  if (stringArg(args, "system_prompt") || stringArg(args, "systemPrompt")) {
    nextBody.system_prompt =
      stringArg(args, "system_prompt") ?? stringArg(args, "systemPrompt");
  }
  if (stringArg(args, "model")) nextBody.model = stringArg(args, "model");
  const ioFromArgs = coercePlainObject(args.io);
  if (ioFromArgs) nextBody.io = ioFromArgs;

  const stages = [...(draft.stages ?? [])];
  const artIndex = stages.findIndex(
    (s) =>
      s.path.replace(/^\.\//, "") === uses.replace(/^\.\//, "") ||
      s.body.id === stageId,
  );
  const artifact = { path: uses.startsWith("./") ? uses : `./${uses}`, body: nextBody };
  if (artIndex >= 0) {
    stages[artIndex] = artifact;
  } else {
    stages.push(artifact);
  }

  return {
    ok: true,
    stageId,
    nextDraft: {
      ...draft,
      pipeline: { ...draft.pipeline, stages: pipelineStages },
      stages,
    },
  };
}

export function buildCreatePipelineDraft(
  draft: DraftPackage,
  args: Record<string, unknown>,
): { ok: true; nextDraft: DraftPackage } | { ok: false; error: string } {
  const id = stringArg(args, "id");
  if (!id) return { ok: false, error: "id is required" };
  if (isPlainObject(args.pipeline)) {
    const pipeline = args.pipeline as DraftPackage["pipeline"];
    if (typeof pipeline.id !== "string" || !pipeline.id.trim()) {
      return { ok: false, error: "pipeline.id is required" };
    }
    if (!Array.isArray(pipeline.stages)) {
      return { ok: false, error: "pipeline.stages must be an array" };
    }
    return {
      ok: true,
      nextDraft: {
        ...draft,
        pipeline: {
          ...pipeline,
          id: pipeline.id.trim(),
          model:
            typeof pipeline.model === "string" && pipeline.model.trim()
              ? pipeline.model
              : stringArg(args, "model") ?? peekDefaultModel(),
          stages: normalizePipelineStagesRouteOn(pipeline.stages, {
            ensureEntry: true,
          }),
        },
        ...(Array.isArray(args.stages)
          ? { stages: args.stages as DraftPackage["stages"] }
          : {}),
      },
    };
  }
  return {
    ok: true,
    nextDraft: {
      ...draft,
      pipeline: {
        ...draft.pipeline,
        id,
        model: stringArg(args, "model") ?? peekDefaultModel(),
        ...(args.agent !== undefined ? { agent: args.agent } : {}),
        ...(Array.isArray(args.stages)
          ? {
              stages: normalizePipelineStagesRouteOn(
                args.stages as DraftPackage["pipeline"]["stages"],
                { ensureEntry: true },
              ),
            }
          : {}),
      },
    },
  };
}

function normalizeDraftStagePath(stagePath: string): string {
  return stagePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function stageWiringMatchesArtifact(
  stage: Record<string, unknown>,
  artifact: { path: string; body: Record<string, unknown> },
): boolean {
  const id = typeof stage.id === "string" ? stage.id : "";
  const uses = typeof stage.uses === "string" ? stage.uses : "";
  const bodyId =
    typeof artifact.body.id === "string" ? artifact.body.id : "";
  return (
    (uses.length > 0 &&
      normalizeDraftStagePath(artifact.path) ===
        normalizeDraftStagePath(uses)) ||
    (id.length > 0 && bodyId === id)
  );
}

/** Refuse stages wiring that diverges from draft.stages bodies (no silent prune). */
export function validateEditPipelineStagesWiring(
  draft: DraftPackage,
  nextStages: Array<Record<string, unknown>>,
): string | null {
  const artifacts = draft.stages ?? [];
  for (const stage of nextStages) {
    const matched = artifacts.some((artifact) =>
      stageWiringMatchesArtifact(stage, artifact),
    );
    if (!matched) {
      const label =
        (typeof stage.id === "string" && stage.id) ||
        (typeof stage.uses === "string" && stage.uses) ||
        "(unnamed)";
      return `edit_pipeline stages wiring references "${label}" without a matching stage body — use create_stage / edit_stage to add or change stage files`;
    }
  }
  for (const artifact of artifacts) {
    const stillWired = nextStages.some((stage) =>
      stageWiringMatchesArtifact(stage, artifact),
    );
    if (!stillWired) {
      const label =
        (typeof artifact.body.id === "string" && artifact.body.id) ||
        artifact.path;
      return `edit_pipeline stages wiring drops stage body "${label}" — use create_stage / edit_stage to change stage files; wiring-only remove is refused`;
    }
  }
  return null;
}

export function buildEditPipelineDraft(
  draft: DraftPackage,
  args: Record<string, unknown>,
): { ok: true; nextDraft: DraftPackage } | { ok: false; error: string } {
  const patch = isPlainObject(args.patch) ? args.patch : args;
  const nextPipeline: DraftPackage["pipeline"] = {
    ...draft.pipeline,
  };
  if (stringArg(patch, "id")) nextPipeline.id = stringArg(patch, "id")!;
  if (stringArg(patch, "model")) nextPipeline.model = stringArg(patch, "model");
  if (patch.agent !== undefined) nextPipeline.agent = patch.agent;
  if (Array.isArray(patch.stages)) {
    const nextStages = normalizePipelineStagesRouteOn(
      patch.stages as DraftPackage["pipeline"]["stages"],
    );
    const wiringError = validateEditPipelineStagesWiring(draft, nextStages);
    if (wiringError) return { ok: false, error: wiringError };
    nextPipeline.stages = nextStages;
  }
  if (patch.schemas !== undefined) nextPipeline.schemas = patch.schemas;
  if (patch.requires !== undefined) nextPipeline.requires = patch.requires;
  if (isStringList(patch.memories)) {
    if (patch.memories.length === 0) delete nextPipeline.memories;
    else nextPipeline.memories = patch.memories;
  }
  if (patch.channels !== undefined) {
    if (Array.isArray(patch.channels) && patch.channels.length === 0) {
      delete nextPipeline.channels;
    } else {
      nextPipeline.channels = patch.channels;
    }
  }
  return {
    ok: true,
    nextDraft: { ...draft, pipeline: nextPipeline },
  };
}

export function buildCreateTaskDraft(
  draft: DraftPackage,
  args: Record<string, unknown>,
): { ok: true; nextDraft: DraftPackage; taskId: string } | { ok: false; error: string } {
  const goal =
    stringArg(args, "goal") ?? stringArg(args, "summary") ?? "Describe the workflow goal";
  const taskId =
    stringArg(args, "id") ?? slugifyId(goal, "task");
  const filename =
    stringArg(args, "filename") ?? `${taskId}.task.yaml`;
  const body = isPlainObject(args.body)
    ? { ...args.body, id: taskId, goal: stringArg(args.body, "goal") ?? goal }
    : { id: taskId, goal };
  return {
    ok: true,
    taskId,
    nextDraft: {
      ...draft,
      task: { filename, body },
    },
  };
}

export function buildEditTaskDraft(
  draft: DraftPackage,
  args: Record<string, unknown>,
): { ok: true; nextDraft: DraftPackage; taskId: string } | { ok: false; error: string } {
  if (!draft.task) {
    return { ok: false, error: "no task on draft — use create_task first" };
  }
  const patch = isPlainObject(args.patch) ? args.patch : {};
  const bodyFromArgs = isPlainObject(args.body) ? args.body : null;
  const nextBody: Record<string, unknown> = {
    ...draft.task.body,
    ...patch,
    ...(bodyFromArgs ?? {}),
  };
  if (stringArg(args, "id")) nextBody.id = stringArg(args, "id");
  if (stringArg(args, "goal")) nextBody.goal = stringArg(args, "goal");
  const taskId =
    typeof nextBody.id === "string" && nextBody.id ? nextBody.id : "task";
  const filename =
    stringArg(args, "filename") ?? draft.task.filename;
  return {
    ok: true,
    taskId,
    nextDraft: {
      ...draft,
      task: { filename, body: nextBody },
    },
  };
}

export type WorkshopAuthorToolOptions = {
  projectRoot?: string;
};

const WORKSHOP_TURN_REQUIRED =
  "workshop chat session is required";

function liveWorkshopBinding(ctx: OperatorAgentToolContext) {
  return resolveLiveWorkshopBinding(ctx.getContext());
}

async function listPickerCatalog(storeRoot: string): Promise<{
  pipelines: WorkshopPickerCatalogPipeline[];
  roots: { project_root: string; path: string }[];
}> {
  const { createRunStore } = await import("../../runstore/createStore.js");
  const { listPipelinesMultiProject } = await import(
    "../../config/multiProjectCatalog.js"
  );
  const store = createRunStore({ rootDir: storeRoot });
  try {
    const listed = await listPipelinesMultiProject({ store });
    return {
      pipelines: resolvePickerCatalogPipelines(listed.items, listed.roots),
      roots: listed.roots,
    };
  } finally {
    await store.close();
  }
}

export function createWorkshopBuildTools(): OperatorAgentTool[] {
  const listBuildsTool: OperatorAgentTool = {
    name: "list_builds",
    description:
      "List the same workshop rows as the studio picker (open builds and unbound disk pipelines). Each row includes catalogListed (whether Tasks/Pipelines would list that pipeline path). Does not create a build. Works when no build is focused.",
    parameters: emptyParams,
    async handler(_args, ctx): Promise<OperatorAgentToolResult> {
      const live = liveWorkshopBinding(ctx);
      if (!live) {
        return { ok: false, content: null, error: WORKSHOP_TURN_REQUIRED };
      }
      try {
        const catalog = await listPickerCatalog(live.storeRoot);
        const rows = listWorkshopPickerRows(
          live.storeRoot,
          catalog.pipelines,
          catalog.roots,
        ).map((row) => {
          if (!row.projectRoot || !row.relativePath) {
            return { ...row, catalogListed: false };
          }
          const relPath = row.relativePath;
          const normalize = (value: string) =>
            value.replace(/\\/g, "/").replace(/^\.\//, "");
          const listed = catalog.pipelines.some(
            (pipeline) =>
              pipeline.project_root === row.projectRoot &&
              normalize(pipeline.path) === normalize(relPath),
          );
          return { ...row, catalogListed: listed };
        });
        return { ok: true, content: { rows } };
      } catch (err) {
        return {
          ok: false,
          content: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  const focusBuildTool: OperatorAgentTool = {
    name: "focus_build",
    description:
      "Move this chat onto a build by id, or onto an unbound disk pipeline by projectRoot and relativePath. Mid-turn, the mutation pin moves with the focus so studio and draft tools stay on the same build. A failed open returns the error, creates nothing, and leaves the pointer unchanged.",
    parameters: Type.Union([
      Type.Object({ id: Type.String({ minLength: 1 }) }, closed),
      Type.Object(
        {
          projectRoot: Type.String({ minLength: 1 }),
          relativePath: Type.String({ minLength: 1 }),
        },
        closed,
      ),
    ]),
    async handler(args, ctx): Promise<OperatorAgentToolResult> {
      const live = liveWorkshopBinding(ctx);
      if (!live) {
        return { ok: false, content: null, error: WORKSHOP_TURN_REQUIRED };
      }
      const buildId = stringArg(args, "buildId") ?? stringArg(args, "id");
      const projectRoot =
        stringArg(args, "projectRoot") ?? stringArg(args, "project_root");
      const relativePath =
        stringArg(args, "relativePath") ??
        stringArg(args, "relative_path") ??
        stringArg(args, "path");

      if (!buildId && projectRoot && relativePath) {
        let resolvedRoot = projectRoot;
        const { createRunStore } = await import("../../runstore/createStore.js");
        const { CatalogPathError, resolveCatalogStartInput } = await import(
          "../../config/catalogRelativePath.js"
        );
        const store = createRunStore({ rootDir: live.storeRoot });
        try {
          const { wireRoot } = await resolveCatalogStartInput(
            { store },
            projectRoot,
          );
          resolvedRoot = wireRoot.path;
        } catch (err) {
          if (!(err instanceof CatalogPathError)) throw err;
        } finally {
          await store.close();
        }
        const focused = await focusUnboundWorkshopBuild(live.storeRoot, {
          projectRoot: resolvedRoot,
          relativePath,
        });
        if (!focused.ok) {
          return { ok: false, content: null, error: focused.error };
        }
        focusWorkshopBuildPointer({
          sessionId: live.sessionId,
          buildId: focused.build.id,
          registry: live.registry,
          storeRoot: live.storeRoot,
        });
        return { ok: true, content: { build: focused.build } };
      }

      if (!buildId) {
        return {
          ok: false,
          content: null,
          error: "build id or project root and path are required",
        };
      }

      try {
        const pointed = focusWorkshopBuildPointer({
          sessionId: live.sessionId,
          buildId,
          registry: live.registry,
          storeRoot: live.storeRoot,
        });
        return {
          ok: true,
          content: { build: getWorkshopBuild(live.storeRoot, pointed.activeBuildId) },
        };
      } catch (err) {
        return {
          ok: false,
          content: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  const createBuildTool: OperatorAgentTool = {
    name: "create_build",
    description:
      "Persist a new untitled build and focus it when none is pinned. When a build is already pinned, returns that build without creating another. No build id argument.",
    parameters: emptyParams,
    async handler(_args, ctx): Promise<OperatorAgentToolResult> {
      const live = liveWorkshopBinding(ctx);
      if (!live) {
        return { ok: false, content: null, error: WORKSHOP_TURN_REQUIRED };
      }
      const build = pinWorkshopBuildOnCreate({
        sessionId: live.sessionId,
        draft: emptyDraftPackage(),
        registry: live.registry,
        storeRoot: live.storeRoot,
      });
      return { ok: true, content: { build } };
    },
  };

  return [listBuildsTool, focusBuildTool, createBuildTool];
}

export function createWorkshopAuthorMutatingTools(): OperatorAgentTool[] {
  const createPipelineTool: OperatorAgentTool = {
    name: "create_pipeline",
    description:
      "Create or replace the draft pipeline (id, optional model/stages). Mutates the in-memory draft immediately.",
    parameters: Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        model: Type.Optional(Type.String()),
        agent: Type.Optional(Type.Unknown()),
        stages: Type.Optional(Type.Array(jsonObject)),
        pipeline: Type.Optional(jsonObject),
      },
      closed,
    ),
    handler(args, ctx): OperatorAgentToolResult {
      const built = buildCreatePipelineDraft(readDraftFromContext(ctx.getContext()), args);
      if (!built.ok) return { ok: false, content: null, error: built.error };
      const proposal = applyMutation(
        ctx,
        `Set pipeline “${built.nextDraft.pipeline.id}”`,
        built.nextDraft,
      );
      return { ok: true, content: proposal };
    },
  };

  const editPipelineTool: OperatorAgentTool = {
    name: "edit_pipeline",
    description:
      "Edit pipeline fields on the current draft (id, model, stages wiring, etc.). Stages wiring must match existing stage bodies — use create_stage / edit_stage to add or remove stages. Mutates immediately.",
    parameters: Type.Object(
      {
        id: Type.Optional(Type.String()),
        model: Type.Optional(Type.String()),
        agent: Type.Optional(Type.Unknown()),
        stages: Type.Optional(Type.Array(jsonObject)),
        schemas: Type.Optional(Type.Unknown()),
        requires: Type.Optional(Type.Unknown()),
        memories: Type.Optional(Type.Array(Type.String())),
        channels: Type.Optional(Type.Unknown()),
        patch: Type.Optional(jsonObject),
      },
      closed,
    ),
    handler(args, ctx): OperatorAgentToolResult {
      const built = buildEditPipelineDraft(readDraftFromContext(ctx.getContext()), args);
      if (!built.ok) return { ok: false, content: null, error: built.error };
      const proposal = applyMutation(
        ctx,
        `Edit pipeline “${built.nextDraft.pipeline.id}”`,
        built.nextDraft,
      );
      return { ok: true, content: proposal };
    },
  };

  const createStageTool: OperatorAgentTool = {
    name: "create_stage",
    description:
      "Add a file-backed stage to the draft (uses: ./id.yaml + stage body with io). Mutates immediately; Accept confirms, Reject soft-undos.",
    parameters: Type.Object(
      {
        id: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        label: Type.Optional(Type.String()),
        uses: Type.Optional(Type.String()),
        body: Type.Optional(jsonObject),
        system_prompt: Type.Optional(Type.String()),
        model: Type.Optional(Type.String()),
        io: Type.Optional(jsonObject),
        entry: Type.Optional(Type.Boolean()),
        route: Type.Optional(Type.Array(Type.Unknown())),
      },
      closed,
    ),
    handler(args, ctx): OperatorAgentToolResult {
      const built = buildCreateStageDraft(readDraftFromContext(ctx.getContext()), args);
      if (!built.ok) return { ok: false, content: null, error: built.error };
      const proposal = applyMutation(
        ctx,
        `Add stage “${built.stageId}”`,
        built.nextDraft,
      );
      return { ok: true, content: proposal };
    },
  };

  const editStageTool: OperatorAgentTool = {
    name: "edit_stage",
    description:
      "Edit an existing draft stage by id (body fields and/or pipeline entry route/entry/uses). Mutates immediately.",
    parameters: Type.Object(
      {
        id: Type.String({ minLength: 1 }),
        patch: Type.Optional(jsonObject),
        body: Type.Optional(jsonObject),
        pipeline_entry: Type.Optional(jsonObject),
        entry: Type.Optional(Type.Boolean()),
        route: Type.Optional(Type.Array(Type.Unknown())),
        uses: Type.Optional(Type.String()),
        system_prompt: Type.Optional(Type.String()),
        model: Type.Optional(Type.String()),
        io: Type.Optional(jsonObject),
      },
      closed,
    ),
    handler(args, ctx): OperatorAgentToolResult {
      const built = buildEditStageDraft(readDraftFromContext(ctx.getContext()), args);
      if (!built.ok) return { ok: false, content: null, error: built.error };
      const proposal = applyMutation(
        ctx,
        `Edit stage “${built.stageId}”`,
        built.nextDraft,
      );
      return { ok: true, content: proposal };
    },
  };

  const createTaskTool: OperatorAgentTool = {
    name: "create_task",
    description:
      "Create or replace the optional task (id + goal) on the draft. Mutates immediately.",
    parameters: Type.Object(
      {
        id: Type.Optional(Type.String()),
        goal: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        filename: Type.Optional(Type.String()),
        body: Type.Optional(jsonObject),
      },
      closed,
    ),
    handler(args, ctx): OperatorAgentToolResult {
      const built = buildCreateTaskDraft(readDraftFromContext(ctx.getContext()), args);
      if (!built.ok) return { ok: false, content: null, error: built.error };
      const proposal = applyMutation(
        ctx,
        `Create task “${built.taskId}”`,
        built.nextDraft,
      );
      return { ok: true, content: proposal };
    },
  };

  const editTaskTool: OperatorAgentTool = {
    name: "edit_task",
    description:
      "Edit the draft task fields (id, goal, body). Mutates immediately.",
    parameters: Type.Object(
      {
        id: Type.Optional(Type.String()),
        goal: Type.Optional(Type.String()),
        filename: Type.Optional(Type.String()),
        patch: Type.Optional(jsonObject),
        body: Type.Optional(jsonObject),
      },
      closed,
    ),
    handler(args, ctx): OperatorAgentToolResult {
      const built = buildEditTaskDraft(readDraftFromContext(ctx.getContext()), args);
      if (!built.ok) return { ok: false, content: null, error: built.error };
      const proposal = applyMutation(
        ctx,
        `Edit task “${built.taskId}”`,
        built.nextDraft,
      );
      return { ok: true, content: proposal };
    },
  };

  return [
    createPipelineTool,
    editPipelineTool,
    createStageTool,
    editStageTool,
    createTaskTool,
    editTaskTool,
  ];
}

export function createSaveTool(
  options: WorkshopAuthorToolOptions = {},
): OperatorAgentTool {
  return {
    name: "save",
    description:
      "Validate-then-write the draft via catalog facades (createDraftPackage / overwriteDraftPackage). When directory is omitted, writes under workshop/<pipeline-id> on registered catalogs (or <pipeline-id> on the workspace catalog). The host adds registered workshop paths to stageflow.yaml so Run can see them. Pass directory only when the operator names a folder. Soft undo does not reverse disk. Prefer mode auto; set allowInvalid only when the operator explicitly requests saving invalid YAML. Do not pass projectRoot — the host binds it.",
    parameters: Type.Object(
      {
        directory: Type.Optional(Type.String()),
        pipelineFilename: Type.Optional(Type.String()),
        mode: Type.Optional(
          Type.Union([Type.Literal("auto"), Type.Literal("create"), Type.Literal("overwrite")]),
        ),
        allowInvalid: Type.Optional(Type.Boolean()),
      },
      closed,
    ),
    async handler(args, ctx): Promise<OperatorAgentToolResult> {
      const writeTarget = await resolveSaveWriteTarget(ctx, options);
      if (!writeTarget.ok) {
        return {
          ok: false,
          content: null,
          error: writeTarget.error,
        };
      }
      const { fsRoot, catalogRootKind, wireProjectRoot } = writeTarget.target;

      const pinnedDestination = resolvePinnedSaveDestination(
        ctx.getContext(),
        fsRoot,
      );
      const destination =
        pinnedDestination ?? resolveDestination(ctx, args, catalogRootKind);
      if (!destination) {
        return {
          ok: false,
          content: null,
          error:
            "destination is required — set context.destination or pass directory (do not invent a disk path)",
        };
      }

      const draft = readDraftFromContext(ctx.getContext());
      const allowInvalid = args.allowInvalid === true;
      const modeRaw = stringArg(args, "mode") ?? "auto";
      const mode =
        modeRaw === "create" || modeRaw === "overwrite" || modeRaw === "auto"
          ? modeRaw
          : "auto";

      const input = {
        directory: destination.directory,
        draft,
        ...(destination.pipelineFilename
          ? { pipelineFilename: destination.pipelineFilename }
          : {}),
        ...(allowInvalid ? { allowInvalid: true } : {}),
      };

      const published = await publishDraftPackage(fsRoot, input, mode, {
        catalogRootKind,
      });
      const result = published.write;

      if (result.ok) {
        const current = readWorkshopContext(ctx);
        ctx.setContext({
          ...current,
          draft: withDraft(current, draft).draft,
          destination: {
            directory: destination.directory,
            ...(destination.pipelineFilename
              ? { pipelineFilename: destination.pipelineFilename }
              : {}),
          },
          projectRoot: fsRoot,
        });
        recordPinnedWorkshopSave(ctx.getContext(), {
          directory: destination.directory,
          ...(destination.pipelineFilename
            ? { pipelineFilename: destination.pipelineFilename }
            : {}),
          projectRoot: fsRoot,
          draft,
          relativePath: result.pipelinePath,
        });
      }

      return {
        ok: result.ok,
        content: result.ok
          ? {
              ...result,
              published: {
                project_root: wireProjectRoot,
                project_root_path: fsRoot,
                pipeline_path: result.pipelinePath,
                stage_paths: result.stagePaths,
                ...(result.taskPath !== undefined
                  ? { task_path: result.taskPath }
                  : { task_path: null }),
              },
            }
          : result,
        ...(result.ok ? {} : { error: result.error }),
      };
    },
  };
}

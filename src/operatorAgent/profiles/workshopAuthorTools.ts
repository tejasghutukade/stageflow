import { parse as parseYaml } from "yaml";
import {
  validateDraftPackage,
  type DraftPackage,
} from "../../config/draftPackage.js";
import { defaultWorkshopPackageDirectory } from "../../config/ensureCatalogScanRoot.js";
import { publishDraftPackage } from "../../config/publishDraftPackage.js";
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

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

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
): { directory: string; pipelineFilename?: string } | null {
  const directory =
    stringArg(args, "directory") ??
    readWorkshopContext(ctx).destination?.directory ??
    defaultWorkshopPackageDirectory(
      readDraftFromContext(ctx.getContext()).pipeline.id,
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
    model: stringArg(args, "model") ?? DEFAULT_MODEL,
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
    pipelineEntry.route = args.route;
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
    if (Array.isArray(args.route)) next.route = args.route;
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
      model: DEFAULT_MODEL,
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
        pipeline: { ...pipeline, id: pipeline.id.trim() },
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
        ...(stringArg(args, "model") ? { model: stringArg(args, "model") } : {}),
        ...(args.agent !== undefined ? { agent: args.agent } : {}),
        ...(Array.isArray(args.stages)
          ? { stages: args.stages as DraftPackage["pipeline"]["stages"] }
          : {}),
      },
    },
  };
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
    nextPipeline.stages = patch.stages as DraftPackage["pipeline"]["stages"];
  }
  if (patch.schemas !== undefined) nextPipeline.schemas = patch.schemas;
  if (patch.requires !== undefined) nextPipeline.requires = patch.requires;
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
      "List the same workshop rows as the studio picker (open builds and unbound disk pipelines). Does not create a build. Works when no build is focused.",
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
        );
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
      "Move this chat onto a build by id, or onto an unbound disk pipeline by projectRoot and relativePath. A failed open returns the error, creates nothing, and leaves the pointer unchanged.",
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
      "Persist a new untitled build and focus it, including when another build is already focused. No build id argument.",
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
      "Edit pipeline fields on the current draft (id, model, stages wiring, etc.). Mutates immediately.",
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
      "Validate-then-write the draft via catalog facades (createDraftPackage / overwriteDraftPackage). When directory is omitted, writes under workshop/<pipeline-id>, which the host adds to the catalog so Run can see the pipeline and task. Pass directory only when the operator names a folder. Soft undo does not reverse disk. Prefer mode auto; set allowInvalid only when the operator explicitly requests saving invalid YAML. Do not pass projectRoot — the host binds it.",
    async handler(args, ctx): Promise<OperatorAgentToolResult> {
      const pinnedDestination = resolvePinnedSaveDestination(ctx.getContext());
      const destination = pinnedDestination ?? resolveDestination(ctx, args);
      if (!destination) {
        return {
          ok: false,
          content: null,
          error:
            "destination is required — set context.destination or pass directory (do not invent a disk path)",
        };
      }
      const projectRoot = resolveProjectRoot(ctx, options.projectRoot);
      if (!projectRoot) {
        return {
          ok: false,
          content: null,
          error:
            "projectRoot is required — bind it on the draft context (host-owned; do not invent from tool args)",
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

      const published = await publishDraftPackage(projectRoot, input, mode);
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
          projectRoot,
        });
        recordPinnedWorkshopSave(ctx.getContext(), {
          directory: destination.directory,
          ...(destination.pipelineFilename
            ? { pipelineFilename: destination.pipelineFilename }
            : {}),
          projectRoot,
          draft,
        });
      }

      return {
        ok: result.ok,
        content: result,
        ...(result.ok ? {} : { error: result.error }),
      };
    },
  };
}

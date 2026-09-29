import {
  createDraftPackage,
  overwriteDraftPackage,
  validateDraftPackage,
  type DraftPackage,
  type DraftPackageWriteResult,
} from "../../config/draftPackage.js";
import {
  isWorkshopDraftContext,
  readDraftFromContext,
  withDraft,
} from "../draftContext.js";
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
    readWorkshopContext(ctx).destination?.directory;
  if (!directory) return null;
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
  const bodyFromArgs = isPlainObject(args.body) ? args.body : null;
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
  if (isPlainObject(args.io)) {
    stageBody.io = args.io;
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
  const bodyFromArgs = isPlainObject(args.body) ? args.body : null;
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
  if (isPlainObject(args.io)) nextBody.io = args.io;

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
      "Validate-then-write the draft via catalog facades (createDraftPackage / overwriteDraftPackage). Requires a destination directory (context.destination or args.directory). Soft undo does not reverse disk. Prefer mode auto; set allowInvalid only when the operator explicitly requests saving invalid YAML. Do not pass projectRoot — the host binds it.",
    async handler(args, ctx): Promise<OperatorAgentToolResult> {
      const destination = resolveDestination(ctx, args);
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

      let result: DraftPackageWriteResult;
      if (mode === "create") {
        result = await createDraftPackage(projectRoot, input);
      } else if (mode === "overwrite") {
        result = await overwriteDraftPackage(projectRoot, input);
      } else {
        const created = await createDraftPackage(projectRoot, input);
        if (created.ok || created.status !== 409) {
          result = created;
        } else {
          result = await overwriteDraftPackage(projectRoot, input);
        }
      }

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
      }

      return {
        ok: result.ok,
        content: result,
        ...(result.ok ? {} : { error: result.error }),
      };
    },
  };
}

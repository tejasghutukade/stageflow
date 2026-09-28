import type { DraftPackage, DraftStageArtifact } from "./draft";

const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

function stageIdAt(
  stage: Record<string, unknown>,
  index: number,
): string {
  return typeof stage.id === "string" && stage.id ? stage.id : `stage-${index}`;
}

export function findPipelineStageIndex(
  draft: DraftPackage,
  stageId: string,
): number {
  return draft.pipeline.stages.findIndex(
    (stage, index) => stageIdAt(stage, index) === stageId,
  );
}

export function findStageArtifact(
  draft: DraftPackage,
  stageId: string,
): { artifact: DraftStageArtifact; index: number } | null {
  const stages = draft.stages ?? [];
  for (let i = 0; i < stages.length; i += 1) {
    const artifact = stages[i]!;
    const bodyId =
      typeof artifact.body.id === "string" ? artifact.body.id : undefined;
    if (bodyId === stageId) return { artifact, index: i };
  }
  const pipeIndex = findPipelineStageIndex(draft, stageId);
  if (pipeIndex < 0) return null;
  const ref = draft.pipeline.stages[pipeIndex]!;
  if (typeof ref.uses !== "string" || !ref.uses.trim()) return null;
  const uses = ref.uses.trim().replace(/\\/g, "/");
  const normalized = uses.replace(/^\.\//, "");
  for (let i = 0; i < stages.length; i += 1) {
    const artifact = stages[i]!;
    const pathNorm = artifact.path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (pathNorm === normalized || artifact.path === uses) {
      return { artifact, index: i };
    }
  }
  return null;
}

/** Core-path stage body fields (file-backed or inline). */
export function patchStageBody(
  draft: DraftPackage,
  stageId: string,
  patch: Record<string, unknown>,
): DraftPackage {
  const apply = (body: Record<string, unknown>): Record<string, unknown> => {
    const next = { ...body };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
      else next[key] = value;
    }
    return next;
  };

  const file = findStageArtifact(draft, stageId);
  if (file) {
    const stages = [...(draft.stages ?? [])];
    stages[file.index] = {
      ...file.artifact,
      body: apply(file.artifact.body),
    };
    return { ...draft, stages };
  }
  const index = findPipelineStageIndex(draft, stageId);
  if (index < 0) return draft;
  const stages = [...draft.pipeline.stages];
  stages[index] = apply(stages[index]!);
  return {
    ...draft,
    pipeline: { ...draft.pipeline, stages },
  };
}

export function readStageBody(
  draft: DraftPackage,
  stageId: string,
): Record<string, unknown> | null {
  const file = findStageArtifact(draft, stageId);
  if (file) return file.artifact.body;
  const index = findPipelineStageIndex(draft, stageId);
  if (index < 0) return null;
  return draft.pipeline.stages[index]!;
}

/** Pipeline-level wiring fields on the stage ref (entry, route, needs, uses). */
export function patchPipelineStageRef(
  draft: DraftPackage,
  stageId: string,
  patch: Record<string, unknown>,
): DraftPackage {
  const index = findPipelineStageIndex(draft, stageId);
  if (index < 0) return draft;
  const stages = [...draft.pipeline.stages];
  const next = { ...stages[index]!, ...patch };
  for (const key of Object.keys(patch)) {
    if (patch[key] === undefined) delete next[key];
  }
  stages[index] = next;
  return {
    ...draft,
    pipeline: { ...draft.pipeline, stages },
  };
}

export function patchPipelineMeta(
  draft: DraftPackage,
  patch: Partial<DraftPackage["pipeline"]>,
): DraftPackage {
  return {
    ...draft,
    pipeline: {
      ...draft.pipeline,
      ...patch,
      stages: patch.stages ?? draft.pipeline.stages,
    },
  };
}

export function removeStageFromDraft(
  draft: DraftPackage,
  stageId: string,
): DraftPackage {
  const index = findPipelineStageIndex(draft, stageId);
  if (index < 0) return draft;
  const removed = draft.pipeline.stages[index]!;
  const pipelineStages = draft.pipeline.stages.filter((_, i) => i !== index);

  let stages = draft.stages;
  if (typeof removed.uses === "string" && removed.uses.trim() && stages) {
    const uses = removed.uses.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    stages = stages.filter((artifact) => {
      const pathNorm = artifact.path.replace(/\\/g, "/").replace(/^\.\//, "");
      return pathNorm !== uses;
    });
  }

  const cleaned = pipelineStages.map((stage) => {
    const next = { ...stage };
    if (Array.isArray(next.route)) {
      next.route = next.route.filter(
        (edge) =>
          !(
            edge !== null &&
            typeof edge === "object" &&
            "to" in edge &&
            (edge as { to?: unknown }).to === stageId
          ),
      );
      if ((next.route as unknown[]).length === 0) delete next.route;
    }
    if (next.needs === stageId) delete next.needs;
    return next;
  });

  if (cleaned.length > 0 && !cleaned.some((s) => s.entry === true)) {
    cleaned[0] = { ...cleaned[0]!, entry: true };
  }

  return {
    ...draft,
    pipeline: { ...draft.pipeline, stages: cleaned },
    ...(stages !== undefined ? { stages } : {}),
  };
}

export function addStageToDraft(
  draft: DraftPackage,
  stageId: string,
  options?: { system_prompt?: string; model?: string },
): DraftPackage {
  const existing = new Set(
    draft.pipeline.stages.map((s, i) => stageIdAt(s, i)),
  );
  let id = stageId;
  if (existing.has(id)) {
    id = `${stageId}-${existing.size + 1}`;
  }
  const usesPath = `./${id}.yaml`;
  const body: Record<string, unknown> = {
    id,
    system_prompt: options?.system_prompt ?? `Stage ${id}`,
    model: options?.model ?? DEFAULT_MODEL,
    ...REQUIRED_IO,
  };
  return {
    ...draft,
    pipeline: {
      ...draft.pipeline,
      stages: [
        ...draft.pipeline.stages,
        {
          id,
          uses: usesPath,
          ...(draft.pipeline.stages.length === 0 ? { entry: true } : {}),
        },
      ],
    },
    stages: [...(draft.stages ?? []), { path: usesPath, body }],
  };
}

export function rewireStageRoute(
  draft: DraftPackage,
  fromId: string,
  toId: string | null,
): DraftPackage {
  if (toId === null || toId === "") {
    return patchPipelineStageRef(draft, fromId, { route: undefined });
  }
  return patchPipelineStageRef(draft, fromId, { route: [{ to: toId }] });
}

export function createTaskInDraft(
  draft: DraftPackage,
  input: { id: string; goal: string; filename?: string },
): DraftPackage {
  const id = input.id.trim() || "task";
  const goal = input.goal.trim() || "Describe the goal";
  const filename =
    input.filename?.trim() ||
    `${id.replace(/[^a-zA-Z0-9._-]+/g, "-") || "task"}.task.yaml`;
  return {
    ...draft,
    task: {
      filename: filename.replace(/\\/g, "/").split("/").pop() || filename,
      body: { id, goal },
    },
  };
}

export function setTaskInDraft(
  draft: DraftPackage,
  task: { filename: string; body: Record<string, unknown> },
): DraftPackage {
  return {
    ...draft,
    task: {
      filename: task.filename,
      body: { ...task.body },
    },
  };
}

export function patchTaskBody(
  draft: DraftPackage,
  patch: Record<string, unknown>,
): DraftPackage {
  if (!draft.task) return draft;
  const body = { ...draft.task.body };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete body[key];
    else body[key] = value;
  }
  let filename = draft.task.filename;
  if (typeof patch.id === "string" && patch.id.trim()) {
    const base = patch.id.trim().replace(/[^a-zA-Z0-9._-]+/g, "-") || "task";
    filename = `${base}.task.yaml`;
  }
  return {
    ...draft,
    task: { filename, body },
  };
}

export function detachTaskFromDraft(draft: DraftPackage): DraftPackage {
  if (!draft.task) return draft;
  const { task: _removed, ...rest } = draft;
  return rest;
}

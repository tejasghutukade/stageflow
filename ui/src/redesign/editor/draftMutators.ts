import type { DraftPackagePayload } from "../../api";

export function cloneDraft(draft: DraftPackagePayload): DraftPackagePayload {
  return JSON.parse(JSON.stringify(draft)) as DraftPackagePayload;
}

export function stageIdFromRef(
  stage: Record<string, unknown>,
  index: number,
): string {
  return typeof stage.id === "string" && stage.id.trim()
    ? stage.id.trim()
    : `stage-${index}`;
}

export function updateStageField(
  draft: DraftPackagePayload,
  stageId: string,
  field: string,
  value: unknown,
): DraftPackagePayload {
  const pipelineStages = draft.pipeline.stages.map((stage, index) => {
    if (stageIdFromRef(stage, index) !== stageId) return stage;
    return { ...stage, [field]: value };
  });
  const files = (draft.stages ?? []).map((file) => {
    const bodyId =
      typeof file.body.id === "string" ? file.body.id : undefined;
    const pathId = file.path.replace(/^\.\//, "").replace(/\.ya?ml$/, "");
    if (bodyId !== stageId && pathId !== stageId) return file;
    return { ...file, body: { ...file.body, [field]: value } };
  });
  return {
    ...draft,
    pipeline: { ...draft.pipeline, stages: pipelineStages },
    stages: files.length > 0 ? files : draft.stages,
  };
}

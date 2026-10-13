import { loadPipelineOutcome } from "./loadPipeline.js";
import { getCatalogScanPaths } from "./browseCatalog.js";
import { catalogContextFromStageflow } from "./resolveCatalogContext.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";

export type SkillUsageEntry = {
  stage_ids: string[];
  pipeline_ids: string[];
};

export type SkillUsageIndex = Record<string, SkillUsageEntry>;

function addUsage(
  index: SkillUsageIndex,
  skillName: string,
  pipelineId: string,
  stageId: string,
): void {
  const entry = index[skillName] ?? { stage_ids: [], pipeline_ids: [] };
  if (!entry.pipeline_ids.includes(pipelineId)) {
    entry.pipeline_ids.push(pipelineId);
    entry.pipeline_ids.sort((a, b) => a.localeCompare(b));
  }
  if (!entry.stage_ids.includes(stageId)) {
    entry.stage_ids.push(stageId);
    entry.stage_ids.sort((a, b) => a.localeCompare(b));
  }
  index[skillName] = entry;
}

export async function buildSkillUsageIndex(cwd: string): Promise<SkillUsageIndex | null> {
  const ctx = catalogContextFromStageflow(await resolveStageflowContext(cwd));
  const scanPaths = await getCatalogScanPaths(ctx);
  if (!scanPaths) {
    return null;
  }
  const index: SkillUsageIndex = {};
  const loadCwd = ctx.projectRoot ?? cwd;
  for (const pipelinePath of scanPaths.pipelinePaths) {
    const outcome = await loadPipelineOutcome(pipelinePath, { cwd: loadCwd });
    if (!outcome.ok) {
      continue;
    }
    const pipelineId = outcome.value.pipeline.id;
    for (const stage of outcome.value.stages) {
      if (stage.skill === undefined) {
        continue;
      }
      addUsage(index, stage.skill, pipelineId, stage.id);
    }
  }
  return index;
}

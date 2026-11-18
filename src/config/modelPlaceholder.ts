import path from "node:path";
import type { LoadedPipeline } from "../types/pipeline.js";
import { isModelPlaceholder } from "../cli/initTemplates.js";
import type { ValidationFinding } from "./validateCatalog.js";

export { isModelPlaceholder };

function relPath(cwd: string, absPath: string): string {
  return path.relative(cwd, absPath).replace(/\\/g, "/");
}

export function modelPlaceholderFixHint(): string {
  return "Connect a provider (`sf providers login <id>`), then run `sf init --fix-model` or replace the model in the YAML.";
}

export function findingsForModelPlaceholders(
  cwd: string,
  pipelinePath: string,
  loaded: LoadedPipeline,
): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const relPipeline = relPath(cwd, pipelinePath);

  if (loaded.pipeline.model !== undefined && isModelPlaceholder(loaded.pipeline.model)) {
    findings.push({
      severity: "warning",
      code: "catalog.model_placeholder",
      path: relPipeline,
      message: `Pipeline "${loaded.pipeline.id}" model is still the placeholder "${loaded.pipeline.model}". ${modelPlaceholderFixHint()}`,
      category: "catalog",
      pipelineId: loaded.pipeline.id,
    });
  }

  for (const stage of loaded.stages) {
    const model = stage.model;
    if (model === undefined) continue;
    if (!isModelPlaceholder(model)) continue;
    const source = loaded.stageSources?.[stage.id];
    const stagePath =
      source?.kind === "file" ? relPath(cwd, source.path) : relPipeline;
    findings.push({
      severity: "warning",
      code: "catalog.model_placeholder",
      path: stagePath,
      message: `Stage "${stage.id}" model is still the placeholder "${model}". ${modelPlaceholderFixHint()}`,
      category: "catalog",
      pipelineId: loaded.pipeline.id,
      stageId: stage.id,
    });
  }

  return findings;
}

export function providerIdFromModel(model: string): string | undefined {
  const slash = model.indexOf("/");
  if (slash <= 0) return undefined;
  return model.slice(0, slash).trim().toLowerCase();
}

export async function pipelineHasBlockingPlaceholder(
  pipelinePath: string,
  cwd: string,
): Promise<{ blocked: boolean; message?: string }> {
  const { loadPipelineOutcome } = await import("./loadPipeline.js");
  const abs = path.resolve(cwd, pipelinePath);
  const outcome = await loadPipelineOutcome(abs, { cwd });
  if (!outcome.ok) {
    return { blocked: true, message: outcome.issues[0]?.message ?? "Failed to load pipeline" };
  }
  const findings = findingsForModelPlaceholders(cwd, abs, outcome.value);
  if (findings.length === 0) return { blocked: false };
  return { blocked: true, message: findings[0]!.message };
}
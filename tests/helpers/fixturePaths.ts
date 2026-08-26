import path from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = path.resolve(testsDir, "..");
export const FIXTURES_ROOT = path.join(testsDir, "fixtures");
export const PIPELINES_DIR = path.join(FIXTURES_ROOT, "pipelines");
export const TASKS_DIR = path.join(FIXTURES_ROOT, "tasks");
export const MANIFEST_CATALOG = path.join(FIXTURES_ROOT, "manifest-catalog");
export const PIPELINE_OWNED = path.join(FIXTURES_ROOT, "pipeline-owned");

export function pipelinePath(name: string): string {
  const stem = name.replace(/\.(pipeline\.)?yaml$/, "");
  return path.join(PIPELINES_DIR, `${stem}.pipeline.yaml`);
}

export function taskPath(name: string): string {
  const stem = name.replace(/\.(task\.)?yaml$/, "");
  return path.join(TASKS_DIR, `${stem}.task.yaml`);
}

export const SAMPLE_TASK = taskPath("sample");
export const SINGLE_PIPELINE = pipelinePath("single");
export const DOCS_ONLY_PIPELINE = pipelinePath("docs-only");
export const LINEAR_EXPLICIT_PIPELINE = pipelinePath("linear-explicit");
export const BROKEN_PIPELINE = pipelinePath("broken");
export function catalogLocators(stem: string): {
  pipelineId: string;
  pipelinePath: string;
} {
  const id = stem.replace(/\.(pipeline\.)?yaml$/, "");
  return { pipelineId: id, pipelinePath: pipelinePath(id) };
}

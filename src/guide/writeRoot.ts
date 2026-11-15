import { accessSync } from "node:fs";
import path from "node:path";
import { GUIDE_PIPELINES_ROOT } from "../config/ensureCatalogScanRoot.js";
import { STAGE_ID_PATTERN } from "../config/createStage.js";
import { ensureWorkspaceCatalog, workspaceCatalogPath } from "../project/workspaceCatalog.js";
import { placementDeniedByMode } from "../toolkit/modePolicy.js";
import { resolveMode } from "../toolkit/modes.js";

/** Where the Guide saves. A project with stageflow.yaml keeps its own catalog. Otherwise the workspace catalog, which Pipelines and Catalog list. */
export function guideWriteRoot(hostProjectRoot: string): string {
  try {
    accessSync(path.join(hostProjectRoot, "stageflow.yaml"));
    return hostProjectRoot;
  } catch {
    ensureWorkspaceCatalog();
    return workspaceCatalogPath();
  }
}

/** One folder per pipeline. Stage files are written beside the pipeline file. */
export function guidePipelineDirectory(id: string): string {
  return `${GUIDE_PIPELINES_ROOT}/${id}`;
}

export function guidePipelineFile(id: string): string {
  return `${guidePipelineDirectory(id)}/${id}.pipeline.yaml`;
}

const PACKAGE_PATH_TOOLS = new Set([
  "write_stage",
  "write_pipeline",
  "write_task",
  "read_pipeline",
]);

function pipelineIdFromFile(relPath: string): string | undefined {
  const base = relPath.replace(/\\/g, "/").split("/").pop() ?? "";
  if (!base.endsWith(".pipeline.yaml")) return undefined;
  const id = base.slice(0, -".pipeline.yaml".length);
  return STAGE_ID_PATTERN.test(id) ? id : undefined;
}

function escapesProject(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/");
  return path.isAbsolute(relPath) || norm.startsWith("/") || norm.split("/").includes("..");
}

/**
 * Pipeline and stage files always land in pipelines/<id>/.
 * A path that already exists under the catalog is left alone so an edit keeps that package.
 * Any other path, including one the person named, is rewritten.
 */
export function placeGuideWriteArgs(
  name: string,
  args: Record<string, unknown>,
  fileExists: (relPath: string) => boolean = () => false,
): { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  const refusal = placementDeniedByMode(name, args);
  if (refusal) return { ok: false, message: refusal };
  const next: Record<string, unknown> = { ...args };
  delete next.project_root;

  const id = typeof next.id === "string" ? next.id.trim() : "";
  const resolved = resolveMode(name, args);
  const writeMode = resolved?.ok ? resolved.resolved.mode : undefined;
  if (STAGE_ID_PATTERN.test(id)) {
    if (name === "write_pipeline" && next.mode === "create") next.directory = guidePipelineDirectory(id);
    if (name === "write_stage" && writeMode === "standalone_create") {
      next.pipeline_directory = guidePipelineDirectory(id);
    }
  }

  if (!PACKAGE_PATH_TOOLS.has(name) || typeof next.path !== "string") return { ok: true, args: next };
  const given = next.path.trim();
  const pipelineId = pipelineIdFromFile(given);
  if (!pipelineId) return { ok: true, args: next };
  const canonical = guidePipelineFile(pipelineId);
  if (given.replace(/\\/g, "/") === canonical) return { ok: true, args: next };
  if (escapesProject(given) || !fileExists(given)) next.path = canonical;
  return { ok: true, args: next };
}

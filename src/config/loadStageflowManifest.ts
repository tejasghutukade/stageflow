import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  LoadedManifest,
  StageflowManifest,
  StageflowManifestCatalog,
} from "../types/stageflowManifest.js";
import { loadFailure, loadSuccess, type LoadIssue, type LoadOutcome } from "./loadOutcome.js";

const DEFAULT_PIPELINE_PATTERN = "*.pipeline.yaml";
const DEFAULT_TASK_PATTERN = "*.task.yaml";

export function manifestPathForProject(projectRoot: string): string {
  return path.join(projectRoot, "stageflow.yaml");
}

function catalogIssue(code: string, message: string): LoadIssue {
  return { code, message, category: "catalog" };
}

function normalizeEntryPath(entry: string): string {
  return entry.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function parseStringArray(
  raw: unknown,
  field: string,
  issues: LoadIssue[],
): string[] | null {
  if (!Array.isArray(raw)) {
    issues.push(catalogIssue("catalog.manifest_invalid", `catalog.${field} must be an array`));
    return null;
  }
  const entries: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || item.trim().length === 0) {
      issues.push(
        catalogIssue(
          "catalog.manifest_invalid",
          `catalog.${field} entries must be non-empty strings`,
        ),
      );
      return null;
    }
    const normalized = normalizeEntryPath(item.trim());
    if (path.isAbsolute(normalized)) {
      issues.push(
        catalogIssue(
          "catalog.manifest_invalid",
          `catalog.${field} entries must be repo-relative paths`,
        ),
      );
      return null;
    }
    entries.push(normalized);
  }
  return entries;
}

function parsePatterns(
  raw: unknown,
  issues: LoadIssue[],
): { pipeline: string; task: string } {
  const defaults = {
    pipeline: DEFAULT_PIPELINE_PATTERN,
    task: DEFAULT_TASK_PATTERN,
  };
  if (raw === undefined || raw === null) {
    return defaults;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    issues.push(
      catalogIssue("catalog.manifest_invalid", "catalog.patterns must be an object"),
    );
    return defaults;
  }
  const record = raw as Record<string, unknown>;
  const pipeline =
    record.pipeline === undefined
      ? defaults.pipeline
      : typeof record.pipeline === "string" && record.pipeline.trim().length > 0
        ? record.pipeline.trim()
        : null;
  const task =
    record.task === undefined
      ? defaults.task
      : typeof record.task === "string" && record.task.trim().length > 0
        ? record.task.trim()
        : null;
  if (pipeline === null) {
    issues.push(
      catalogIssue("catalog.manifest_invalid", "catalog.patterns.pipeline must be a string"),
    );
  }
  if (task === null) {
    issues.push(
      catalogIssue("catalog.manifest_invalid", "catalog.patterns.task must be a string"),
    );
  }
  return {
    pipeline: pipeline ?? defaults.pipeline,
    task: task ?? defaults.task,
  };
}

export function parseStageflowManifestOutcome(
  yamlText: string,
  manifestPath: string,
  projectRoot: string,
): LoadOutcome<LoadedManifest> {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return loadFailure([catalogIssue("catalog.manifest_load_error", message)]);
  }

  const issues: LoadIssue[] = [];
  const record = raw as Record<string, unknown> | null | undefined;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return loadFailure([
      catalogIssue("catalog.manifest_invalid", "stageflow.yaml must be a mapping"),
    ]);
  }

  if (record.version !== 1) {
    issues.push(
      catalogIssue("catalog.manifest_invalid", `Unsupported manifest version: ${record.version}`),
    );
  }

  const catalogRaw = record.catalog;
  if (
    catalogRaw === undefined ||
    typeof catalogRaw !== "object" ||
    catalogRaw === null ||
    Array.isArray(catalogRaw)
  ) {
    issues.push(catalogIssue("catalog.manifest_invalid", "catalog object is required"));
    if (issues.length > 0) {
      return loadFailure(issues);
    }
  }

  const catalogRecord = catalogRaw as Record<string, unknown>;
  const pipelines = parseStringArray(catalogRecord.pipelines, "pipelines", issues);
  const tasks = parseStringArray(catalogRecord.tasks, "tasks", issues);
  const excludeRaw = catalogRecord.exclude;
  let exclude: string[] | undefined;
  if (excludeRaw !== undefined) {
    const parsed = parseStringArray(excludeRaw, "exclude", issues);
    if (parsed !== null) {
      exclude = parsed;
    }
  }

  const patterns = parsePatterns(catalogRecord.patterns, issues);

  if (issues.length > 0) {
    return loadFailure(issues);
  }

  if (pipelines === null || tasks === null) {
    return loadFailure(issues);
  }

  const catalog: StageflowManifestCatalog = { pipelines, tasks };
  if (exclude !== undefined) {
    catalog.exclude = exclude;
  }
  if (catalogRecord.patterns !== undefined) {
    catalog.patterns = {};
    if (typeof (catalogRecord.patterns as Record<string, unknown>).pipeline === "string") {
      catalog.patterns.pipeline = patterns.pipeline;
    }
    if (typeof (catalogRecord.patterns as Record<string, unknown>).task === "string") {
      catalog.patterns.task = patterns.task;
    }
  }

  const manifest: StageflowManifest = { version: 1, catalog };
  return loadSuccess({
    path: manifestPath,
    projectRoot,
    manifest,
    patterns,
  });
}

export async function loadStageflowManifestOutcome(
  projectRoot: string,
): Promise<LoadOutcome<LoadedManifest>> {
  const manifestPath = manifestPathForProject(projectRoot);
  try {
    await access(manifestPath);
  } catch {
    return loadFailure([
      catalogIssue("catalog.manifest_load_error", `Manifest not found: ${manifestPath}`),
    ]);
  }

  let yamlText: string;
  try {
    yamlText = await readFile(manifestPath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return loadFailure([catalogIssue("catalog.manifest_load_error", message)]);
  }

  return parseStageflowManifestOutcome(yamlText, manifestPath, projectRoot);
}

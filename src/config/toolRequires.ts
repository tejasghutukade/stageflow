import semver from "semver";
import { loadFailure, loadSuccess, type LoadIssue, type LoadOutcome } from "./loadOutcome.js";

export type ToolRequirement = {
  tool: string;
  version?: string;
};

const ALLOWED_KEYS = new Set(["tool", "version"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiresIssue(
  options: {
    code: "pipeline.invalid_requires" | "stage.invalid_requires";
    category: "pipeline" | "stage";
    pipelineId?: string;
    stageId?: string;
  },
  message: string,
): LoadIssue {
  if (options.category === "pipeline") {
    return {
      code: options.code,
      message,
      category: "pipeline",
      ...(options.pipelineId !== undefined
        ? { pipelineId: options.pipelineId }
        : {}),
      ...(options.stageId !== undefined ? { stageId: options.stageId } : {}),
    };
  }
  return {
    code: options.code,
    message,
    category: "stage",
    ...(options.stageId !== undefined ? { stageId: options.stageId } : {}),
  };
}

export function parseToolRequires(
  raw: unknown,
  label: string,
  options: {
    code: "pipeline.invalid_requires" | "stage.invalid_requires";
    category: "pipeline" | "stage";
    pipelineId?: string;
    stageId?: string;
  },
): LoadOutcome<ToolRequirement[] | undefined> {
  if (raw === undefined) return loadSuccess(undefined);
  if (!Array.isArray(raw)) {
    return loadFailure([
      requiresIssue(
        options,
        `Invalid ${label}: requires must be an array of { tool, version? }`,
      ),
    ]);
  }

  const out: ToolRequirement[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isPlainObject(item)) {
      return loadFailure([
        requiresIssue(options, `Invalid ${label}: requires[${i}] must be an object`),
      ]);
    }
    for (const key of Object.keys(item)) {
      if (!ALLOWED_KEYS.has(key)) {
        return loadFailure([
          requiresIssue(
            options,
            `Invalid ${label}: requires[${i}] unknown key "${key}" (allowed: tool, version)`,
          ),
        ]);
      }
    }
    if (typeof item.tool !== "string" || item.tool.trim() === "") {
      return loadFailure([
        requiresIssue(
          options,
          `Invalid ${label}: requires[${i}].tool must be a non-empty string`,
        ),
      ]);
    }
    const tool = item.tool.trim();
    if (item.version !== undefined) {
      if (typeof item.version !== "string" || item.version.trim() === "") {
        return loadFailure([
          requiresIssue(
            options,
            `Invalid ${label}: requires[${i}].version must be a non-empty semver range string`,
          ),
        ]);
      }
      const range = item.version.trim();
      if (!semver.validRange(range)) {
        return loadFailure([
          requiresIssue(
            options,
            `Invalid ${label}: requires[${i}].version "${range}" is not a valid semver range`,
          ),
        ]);
      }
      out.push({ tool, version: range });
    } else {
      out.push({ tool });
    }
  }
  return loadSuccess(out);
}

/**
 * Merge requirement lists: same tool → intersect version ranges (stricter).
 * Non-intersecting ranges fail with pipeline.requires_conflict.
 */
export function mergeToolRequires(
  lists: Array<readonly ToolRequirement[] | undefined>,
  ctx: { pipelineId: string; label?: string },
): LoadOutcome<ToolRequirement[]> {
  const byTool = new Map<string, string | undefined>();
  for (const list of lists) {
    if (!list) continue;
    for (const req of list) {
      const prior = byTool.get(req.tool);
      if (!byTool.has(req.tool)) {
        byTool.set(req.tool, req.version);
        continue;
      }
      if (prior === undefined && req.version === undefined) continue;
      if (prior === undefined) {
        byTool.set(req.tool, req.version);
        continue;
      }
      if (req.version === undefined) continue;
      if (!semver.intersects(prior, req.version)) {
        return loadFailure([
          {
            code: "pipeline.requires_conflict",
            message: `Pipeline ${ctx.pipelineId}${ctx.label ? ` (${ctx.label})` : ""}: tool "${req.tool}" has non-intersecting version ranges "${prior}" and "${req.version}"`,
            category: "pipeline",
            pipelineId: ctx.pipelineId,
          },
        ]);
      }
      byTool.set(req.tool, `${prior} ${req.version}`);
    }
  }
  return loadSuccess(
    [...byTool.entries()].map(([tool, version]) =>
      version !== undefined ? { tool, version } : { tool },
    ),
  );
}

export function collectEffectiveRequires(options: {
  pipelineRequires?: readonly ToolRequirement[];
  stageRequires: Array<readonly ToolRequirement[] | undefined>;
  pipelineId: string;
}): LoadOutcome<ToolRequirement[]> {
  return mergeToolRequires(
    [options.pipelineRequires, ...options.stageRequires],
    { pipelineId: options.pipelineId },
  );
}

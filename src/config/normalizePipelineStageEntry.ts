import path from "node:path";
import type { NormalizedPipelineStageEntry } from "../types/pipeline.js";
import { loadFailure, loadSuccess, type LoadOutcome } from "./loadOutcome.js";
import {
  BODY_KEYS,
  isAllowedPipelineStageEntryKey,
} from "./pipelineStageKeys.js";
import type { RawMergedEntry } from "./mergePipelineIncludes.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function inferIdFromUsesPath(usesPath: string): string | null {
  const base = path.basename(usesPath);
  if (!base) return null;
  if (base.endsWith(".stage.yaml")) {
    const id = base.slice(0, -".stage.yaml".length);
    return id || null;
  }
  if (base.endsWith(".yaml")) {
    const id = base.slice(0, -".yaml".length);
    return id || null;
  }
  return base;
}

function extractBodyRaw(raw: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (BODY_KEYS.has(key)) {
      body[key] = raw[key];
    }
  }
  return body;
}

function hasBodyKey(raw: Record<string, unknown>): boolean {
  return Object.keys(raw).some((key) => BODY_KEYS.has(key) && key !== "skill");
}

function readSkill(raw: Record<string, unknown>): LoadOutcome<string> | undefined {
  if (raw.skill === undefined) return undefined;
  if (typeof raw.skill !== "string" || raw.skill.trim() === "") {
    return loadFailure([
      {
        code: "stage.invalid_skill",
        message: "skill must be a non-empty string",
        category: "stage",
      },
    ]);
  }
  return loadSuccess(raw.skill.trim());
}

function stringStageRefMessage(
  index: number,
  declaringPath: string,
  entry: string,
): string {
  const hint = entry
    ? `bare string stage refs are not supported; use { id: "${entry}", uses: "./${entry}.yaml" } or inline body`
    : `bare string stage refs are not supported; use { id: "…", uses: "./….yaml" } or inline body`;
  return `Invalid stage entry at index ${index} in ${declaringPath}: ${hint}`;
}

export function normalizePipelineStageEntries(
  rawEntries: RawMergedEntry[],
  ctx: { pipelineId: string; path: string },
): LoadOutcome<NormalizedPipelineStageEntry[]> {
  const normalized: NormalizedPipelineStageEntry[] = [];

  for (let index = 0; index < rawEntries.length; index++) {
    const { raw, declaringPath } = rawEntries[index];

    if (typeof raw === "string") {
      return loadFailure([
        {
          code: "pipeline.string_stage_ref",
          message: stringStageRefMessage(index, declaringPath, raw),
          category: "pipeline",
          pipelineId: ctx.pipelineId,
        },
      ]);
    }

    if (!isPlainObject(raw)) {
      return loadFailure([
        {
          code: "pipeline.invalid_shape",
          message: `Invalid stage entry at index ${index} in ${declaringPath}: expected object`,
          category: "pipeline",
          pipelineId: ctx.pipelineId,
        },
      ]);
    }

    for (const key of Object.keys(raw)) {
      if (!isAllowedPipelineStageEntryKey(key)) {
        return loadFailure([
          {
            code: "pipeline.invalid_shape",
            message: `Pipeline ${ctx.pipelineId} (${ctx.path}): invalid stage entry at index ${index}: unknown key "${key}"`,
            category: "pipeline",
            pipelineId: ctx.pipelineId,
          },
        ]);
      }
    }

    const uses = typeof raw.uses === "string" ? raw.uses : undefined;
    const hasBody = hasBodyKey(raw);
    const skillOutcome = readSkill(raw);
    if (skillOutcome !== undefined && !skillOutcome.ok) {
      return skillOutcome;
    }
    const skill = skillOutcome?.ok ? skillOutcome.value : undefined;

    if (uses && hasBody) {
      return loadFailure([
        {
          code: "pipeline.stage_uses_inline_conflict",
          message: `Pipeline ${ctx.pipelineId} (${ctx.path}): stage entry at index ${index} has both uses and inline body fields`,
          category: "pipeline",
          pipelineId: ctx.pipelineId,
        },
      ]);
    }

    if (!uses && !hasBody) {
      const entryLabel = typeof raw.id === "string" ? raw.id : String(index);
      return loadFailure([
        {
          code: "pipeline.stage_missing_body",
          message: `Pipeline ${ctx.pipelineId} (${ctx.path}): stage "${entryLabel}" has no uses: path or inline body`,
          category: "pipeline",
          pipelineId: ctx.pipelineId,
        },
      ]);
    }

    let id: string | undefined = typeof raw.id === "string" && raw.id ? raw.id : undefined;
    if (!id && uses) {
      const inferred = inferIdFromUsesPath(uses);
      if (inferred) id = inferred;
    }

    if (!id) {
      return loadFailure([
        {
          code: "pipeline.invalid_shape",
          message: `Pipeline ${ctx.pipelineId} (${ctx.path}): invalid stage entry at index ${index}: id must be a non-empty string or inferrable from uses path`,
          category: "pipeline",
          pipelineId: ctx.pipelineId,
        },
      ]);
    }

    if (raw.needs !== undefined) {
      if (Array.isArray(raw.needs)) {
        return loadFailure([
          {
            code: "pipeline.dag_error",
            message: `Pipeline ${ctx.pipelineId} (${ctx.path}): stage "${id}": needs must be a string, not an array`,
            category: "pipeline",
            pipelineId: ctx.pipelineId,
          },
        ]);
      }
      if (typeof raw.needs !== "string" || !raw.needs) {
        return loadFailure([
          {
            code: "pipeline.dag_error",
            message: `Pipeline ${ctx.pipelineId} (${ctx.path}): stage "${id}": needs must be a non-empty string`,
            category: "pipeline",
            pipelineId: ctx.pipelineId,
          },
        ]);
      }
    }

    let forkValue: { select: "one" | "subset"; allow_none?: boolean } | undefined;
    if (raw.fork !== undefined) {
      if (!isPlainObject(raw.fork)) {
        return loadFailure([
          {
            code: "pipeline.dag_error",
            message: `Pipeline ${ctx.pipelineId} (${ctx.path}): stage "${id}": fork must be an object`,
            category: "pipeline",
            pipelineId: ctx.pipelineId,
          },
        ]);
      }
      forkValue = raw.fork as { select: "one" | "subset"; allow_none?: boolean };
    }

    let body: NormalizedPipelineStageEntry["body"];
    if (uses) {
      const absolutePath = path.resolve(path.dirname(declaringPath), uses);
      body = { kind: "uses", path: uses, absolutePath };
    } else {
      body = { kind: "inline", raw: extractBodyRaw(raw) };
    }

    const entry: NormalizedPipelineStageEntry = {
      id,
      declaringPath,
      body,
      ...(typeof raw.needs === "string" ? { needs: raw.needs } : {}),
      ...(forkValue !== undefined ? { fork: forkValue } : {}),
      ...(skill !== undefined ? { skill } : {}),
    };

    const priorPath = normalized.find((e) => e.id === id)?.declaringPath;
    if (priorPath) {
      return loadFailure([
        {
          code: "pipeline.include_duplicate_stage",
          message: `Duplicate stage id "${id}" in ${declaringPath} (also declared in ${priorPath})`,
          category: "pipeline",
          pipelineId: ctx.pipelineId,
        },
      ]);
    }

    normalized.push(entry);
  }

  return loadSuccess(normalized);
}

export function toWiringRefs(
  entries: NormalizedPipelineStageEntry[],
): Array<{ id: string; needs?: string; fork?: { select: "one" | "subset"; allow_none?: boolean } }> {
  return entries.map((entry) => ({
    id: entry.id,
    ...(entry.needs !== undefined ? { needs: entry.needs } : {}),
    ...(entry.fork !== undefined ? { fork: entry.fork } : {}),
  }));
}

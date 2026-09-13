/**
 * Normalize a pipeline `stages:` entry. Target YAML (`io` / `verify` /
 * `on_verify_fail`) compiles onto IR `completion` / `recovery`. Emit/schema
 * fields stay on the YAML-shaped inline body until `parseStageFields`.
 * Legacy YAML keys are dual-read via legacyYaml.ts.
 */
import path from "node:path";
import type { CompletionContract, RecoveryPolicy } from "../types/completion.js";
import type {
  CloneMode,
  NormalizedPipelineStageEntry,
  PipelineRouteEntry,
} from "../types/pipeline.js";
import { loadFailure, loadSuccess, type LoadOutcome } from "./loadOutcome.js";
import { parseStageMcp } from "./loadStage.js";
import { legacyAuthoringRejected, presentLegacyKeys } from "./legacyYaml.js";
import {
  compileTargetContract,
  dialectFromKeys,
  mixedDialectIssue,
} from "./yamlDialect.js";
import {
  BODY_KEYS,
  isAllowedPipelineStageEntryKey,
} from "./pipelineStageKeys.js";
import type { RawMergedEntry } from "./mergePipelineIncludes.js";
import { parseExecutionPolicy } from "./parseCompletionContract.js";
import { parsePipelineRoute } from "./pipelineRoute.js";

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
  return Object.keys(raw).some(
    (key) => BODY_KEYS.has(key) && key !== "skill" && key !== "mcp",
  );
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

    const dialect = dialectFromKeys(Object.keys(raw));
    if (dialect === "invalid") {
      return loadFailure([mixedDialectIssue()]);
    }

    const uses = typeof raw.uses === "string" ? raw.uses : undefined;
    const hasBody = hasBodyKey(raw);
    const skillOutcome = readSkill(raw);
    if (skillOutcome !== undefined && !skillOutcome.ok) {
      return skillOutcome;
    }
    const skill = skillOutcome?.ok ? skillOutcome.value : undefined;
    const mcpOutcome = parseStageMcp(
      raw.mcp,
      `entry at index ${index} in ${declaringPath}`,
    );
    if (!mcpOutcome.ok) return mcpOutcome;
    const mcp = mcpOutcome.value;

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
      return loadFailure([
        {
          code: "pipeline.dag_error",
          message: `Pipeline ${ctx.pipelineId} (${ctx.path}): stage "${id}": "needs" is no longer supported — declare the wiring on the source stage's "route" instead`,
          category: "pipeline",
          pipelineId: ctx.pipelineId,
        },
      ]);
    }
    if (raw.fork !== undefined) {
      return loadFailure([
        {
          code: "pipeline.dag_error",
          message: `Pipeline ${ctx.pipelineId} (${ctx.path}): stage "${id}": "fork" is no longer supported — use "route" instead; listed route targets always run`,
          category: "pipeline",
          pipelineId: ctx.pipelineId,
        },
      ]);
    }
    if (raw.feedback_loop !== undefined) {
      return loadFailure([
        {
          code: "pipeline.dag_error",
          message: `Pipeline ${ctx.pipelineId} (${ctx.path}): stage "${id}": "feedback_loop" is no longer supported — use a "type: loop" entry inside "route" instead`,
          category: "pipeline",
          pipelineId: ctx.pipelineId,
        },
      ]);
    }
    if (raw.route_select !== undefined) {
      return loadFailure([
        {
          code: "pipeline.dag_error",
          message: `Pipeline ${ctx.pipelineId} (${ctx.path}): stage "${id}": "route_select" is no longer supported — listed route targets always run`,
          category: "pipeline",
          pipelineId: ctx.pipelineId,
        },
      ]);
    }
    if (raw.allow_none !== undefined) {
      return loadFailure([
        {
          code: "pipeline.dag_error",
          message: `Pipeline ${ctx.pipelineId} (${ctx.path}): stage "${id}": "allow_none" is no longer supported — listed route targets always run`,
          category: "pipeline",
          pipelineId: ctx.pipelineId,
        },
      ]);
    }
    if (raw.clonable !== undefined) {
      return loadFailure([
        {
          code: "pipeline.dag_error",
          message: `Pipeline ${ctx.pipelineId} (${ctx.path}): stage "${id}": "clonable" is no longer supported — use a Clone Chain instead`,
          category: "pipeline",
          pipelineId: ctx.pipelineId,
        },
      ]);
    }
    let cloneCap: number | undefined;
    if (raw.clone_cap !== undefined) {
      if (
        typeof raw.clone_cap !== "number" ||
        !Number.isInteger(raw.clone_cap) ||
        raw.clone_cap < 1
      ) {
        return loadFailure([
          {
            code: "pipeline.dag_error",
            message: `Pipeline ${ctx.pipelineId} (${ctx.path}): stage "${id}": clone_cap must be an integer >= 1`,
            category: "pipeline",
            pipelineId: ctx.pipelineId,
          },
        ]);
      }
      cloneCap = raw.clone_cap;
    }
    let cloneMode: CloneMode | undefined;
    if (raw.clone_mode !== undefined) {
      if (raw.clone_mode !== "parallel" && raw.clone_mode !== "sequential") {
        return loadFailure([
          {
            code: "pipeline.dag_error",
            message: `Pipeline ${ctx.pipelineId} (${ctx.path}): stage "${id}": clone_mode must be "parallel" or "sequential"`,
            category: "pipeline",
            pipelineId: ctx.pipelineId,
          },
        ]);
      }
      cloneMode = raw.clone_mode;
    }
    if (raw.clone_actions !== undefined) {
      return loadFailure([
        {
          code: "pipeline.dag_error",
          message: `Pipeline ${ctx.pipelineId} (${ctx.path}): stage "${id}": "clone_actions" is no longer supported — use a Clone Chain instead`,
          category: "pipeline",
          pipelineId: ctx.pipelineId,
        },
      ]);
    }

    let policyOutcome: ReturnType<typeof parseExecutionPolicy>;
    if (dialect === "target") {
      const compiled = compileTargetContract(raw, {
        stageId: id,
        label: `entry at index ${index} in ${declaringPath}`,
        category: "pipeline",
        deferSchemaRefs: true,
        requireIo: !uses,
      });
      if (!compiled.ok) return compiled;
      policyOutcome = loadSuccess({
        ...(compiled.value.completion !== undefined
          ? { completion: compiled.value.completion }
          : {}),
        ...(compiled.value.recovery !== undefined
          ? { recovery: compiled.value.recovery }
          : {}),
      });
    } else {
      const rejected = legacyAuthoringRejected(
        dialect,
        `stage "${id}" in ${declaringPath}`,
        presentLegacyKeys(Object.keys(raw)),
      );
      if (rejected) return loadFailure([rejected]);
      policyOutcome = parseExecutionPolicy(raw, id);
    }
    if (!policyOutcome.ok) return policyOutcome;

    if (raw.replay_safe !== undefined && typeof raw.replay_safe !== "boolean") {
      return loadFailure([
        {
          code: "pipeline.dag_error",
          message: `Pipeline ${ctx.pipelineId} (${ctx.path}): stage "${id}": replay_safe must be a boolean`,
          category: "pipeline",
          pipelineId: ctx.pipelineId,
        },
      ]);
    }

    let route: PipelineRouteEntry[] | undefined;
    if (raw.route !== undefined) {
      const parsedRoute = parsePipelineRoute(raw.route, id);
      if (!parsedRoute.ok) {
        return loadFailure([
          {
            code: parsedRoute.code ?? "pipeline.dag_error",
            message: `Pipeline ${ctx.pipelineId} (${ctx.path}): ${parsedRoute.message}`,
            category: "pipeline",
            pipelineId: ctx.pipelineId,
            ...(parsedRoute.code === "pipeline.route_if_invalid" ? { stageId: id } : {}),
          },
        ]);
      }
      route = parsedRoute.value;
    }

    if (raw.entry !== undefined && typeof raw.entry !== "boolean") {
      return loadFailure([
        {
          code: "pipeline.dag_error",
          message: `Pipeline ${ctx.pipelineId} (${ctx.path}): stage "${id}": entry must be a boolean`,
          category: "pipeline",
          pipelineId: ctx.pipelineId,
        },
      ]);
    }
    const entryFlag = raw.entry as boolean | undefined;

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
      ...(policyOutcome.value.completion !== undefined
        ? { completion: policyOutcome.value.completion }
        : {}),
      ...(policyOutcome.value.recovery !== undefined
        ? { recovery: policyOutcome.value.recovery }
        : {}),
      ...(raw.replay_safe !== undefined
        ? { replay_safe: raw.replay_safe as boolean }
        : {}),
      ...(route !== undefined ? { route } : {}),
      ...(entryFlag !== undefined ? { entry: entryFlag } : {}),
      ...(skill !== undefined ? { skill } : {}),
      ...(mcp !== undefined ? { mcp } : {}),
      ...(cloneCap !== undefined ? { clone_cap: cloneCap } : {}),
      ...(cloneMode !== undefined ? { clone_mode: cloneMode } : {}),
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
): Array<{
  id: string;
  completion?: CompletionContract;
  recovery?: RecoveryPolicy;
  replay_safe?: boolean;
  route?: PipelineRouteEntry[];
  entry?: boolean;
  clone_cap?: number;
  clone_mode?: CloneMode;
}> {
  return entries.map((entry) => ({
    id: entry.id,
    ...(entry.completion !== undefined ? { completion: entry.completion } : {}),
    ...(entry.recovery !== undefined ? { recovery: entry.recovery } : {}),
    ...(entry.replay_safe !== undefined ? { replay_safe: entry.replay_safe } : {}),
    ...(entry.route !== undefined ? { route: entry.route } : {}),
    ...(entry.entry !== undefined ? { entry: entry.entry } : {}),
    ...(entry.clone_cap !== undefined ? { clone_cap: entry.clone_cap } : {}),
    ...(entry.clone_mode !== undefined ? { clone_mode: entry.clone_mode } : {}),
  }));
}

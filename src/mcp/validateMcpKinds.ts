import { readFile } from "node:fs/promises";
import path from "node:path";
import { defaultAgentProjectRoot } from "../agents/projectRoot.js";
import type { AgentService } from "../agents/service.js";
import type { ChannelService } from "../channels/service.js";
import {
  CatalogPathError,
  catalogPathErrorBody,
  resolveCatalogRelativePath,
  selectCatalogRootForStart,
} from "../config/catalogRelativePath.js";
import { parseDraftPackageBody, validateDraftPackage } from "../config/draftPackage.js";
import { loadPipeline } from "../config/loadPipeline.js";
import { loadPipelineFromObjectOutcome, loadPipelineOutcome } from "../config/loadPipeline.js";
import { resolveCatalogRoots } from "../config/resolveCatalogRoots.js";
import { validateCatalog, type ValidationResult } from "../config/validateCatalog.js";
import { assertInsideProject, manifestForWrite, resolveWriteDir } from "../config/evalWriteRoots.js";
import {
  EvalApiError,
  locateEval,
  validateEvalText,
} from "../evals/read/api.js";
import { describePipeline } from "../config/describePipeline.js";
import { preflightFailureCode, runPipelinePreflight } from "../preflight/pipelinePreflight.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";
import { z } from "zod";
import { validateFlatSchema } from "../toolkit/catalogToolModes.js";

type ValidateInput = z.infer<typeof validateFlatSchema>;

function optDatasetCases(value: unknown[] | undefined) {
  if (value === undefined) return undefined;
  return value;
}

async function projectRootForEval(deps: McpToolDeps, project_root?: string): Promise<string> {
  if (project_root) {
    const roots = await resolveCatalogRoots({ store: deps.store, bootCwd: deps.cwd });
    const match = roots.find((r) => r.project_root === project_root);
    if (match) return match.path;
  }
  return deps.projectRoot ?? deps.cwd;
}

export async function runValidateKind(deps: McpToolDeps, input: ValidateInput) {
  if (input.preflight === true) {
    return runValidatePreflight(deps, input);
  }
  switch (input.kind) {
    case "catalog":
      return runValidateCatalog(deps, input.strict);
    case "pipeline":
      return runValidatePipeline(deps, input);
    case "task":
      return runValidateTask(deps, input);
    case "draft":
      return runValidateDraft(deps, input);
    case "agent":
      return runValidateAgent(deps, input);
    case "eval":
      return runValidateEval(deps, input);
    case "connection_recipient":
      return runValidateConnectionRecipient(deps, input);
    default:
      return textResult({ error: "Unknown validate kind", status: 400 }, true);
  }
}

async function runValidateCatalog(deps: McpToolDeps, strict?: boolean) {
  try {
    const roots = await resolveCatalogRoots({ store: deps.store, bootCwd: deps.cwd });
    const results: ValidationResult[] = [];
    for (const root of roots) {
      try {
        results.push(
          await validateCatalog({
            cwd: root.path,
            scope: "full",
            strict: strict ?? false,
          }),
        );
      } catch {
        /* skip unreadable root */
      }
    }
    const merged: ValidationResult = {
      scope: "full",
      ok: results.every((r) => r.ok),
      summary: {
        errors: results.reduce((n, r) => n + r.summary.errors, 0),
        warnings: results.reduce((n, r) => n + r.summary.warnings, 0),
      },
      findings: results.flatMap((r) => r.findings),
    };
    return textResult(merged);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return textResult({ error: message, status: 400 }, true);
  }
}

async function runValidatePipeline(deps: McpToolDeps, input: ValidateInput) {
  const pipeline = input.pipeline!;
  if (typeof pipeline === "string") {
    try {
      const roots = await resolveCatalogRoots({ store: deps.store, bootCwd: deps.cwd });
      const resolved = resolveCatalogRelativePath({
        inputPath: pipeline.trim(),
        projectRoot: input.project_root,
        roots,
        fieldName: "pipeline",
      });
      const result = await validateCatalog({
        cwd: resolved.root.path,
        scope: "pipeline",
        projectRoot: resolved.root.path,
        pipeline: resolved.absolutePath,
        strict: input.strict ?? false,
      });
      return textResult(result);
    } catch (err) {
      if (err instanceof CatalogPathError) return textResult(catalogPathErrorBody(err), true);
      throw err;
    }
  }
  const roots = await resolveCatalogRoots({ store: deps.store, bootCwd: deps.cwd });
  const projectRoot = selectCatalogRootForStart(roots, input.project_root).path;
  const outcome = await loadPipelineFromObjectOutcome(pipeline, { cwd: deps.cwd, projectRoot });
  if (!outcome.ok) {
    return textResult(
      {
        error: outcome.issues[0]?.message ?? "pipeline load failed",
        code: outcome.issues[0]?.code ?? "config_invalid",
        issues: outcome.issues,
      },
      true,
    );
  }
  const result = await validateCatalog({
    cwd: projectRoot,
    scope: "pipeline",
    projectRoot,
    pipeline: outcome.value.pipelinePath,
    strict: input.strict ?? false,
  });
  return textResult(result);
}

async function runValidateTask(deps: McpToolDeps, input: ValidateInput) {
  const task = input.task!.trim();
  try {
    const roots = await resolveCatalogRoots({ store: deps.store, bootCwd: deps.cwd });
    const resolved = resolveCatalogRelativePath({
      inputPath: task,
      projectRoot: input.project_root,
      roots,
      fieldName: "task",
    });
    const result = await validateCatalog({
      cwd: resolved.root.path,
      scope: "task",
      projectRoot: resolved.root.path,
      task: resolved.absolutePath,
      strict: input.strict ?? false,
    });
    return textResult(result);
  } catch (err) {
    if (err instanceof CatalogPathError) return textResult(catalogPathErrorBody(err), true);
    throw err;
  }
}

async function runValidateDraft(deps: McpToolDeps, input: ValidateInput) {
  const body =
    input.draft !== undefined
      ? { draft: input.draft, project_root: input.project_root }
      : {
          pipeline: input.package_pipeline!,
          ...(input.stages !== undefined ? { stages: input.stages } : {}),
          ...(input.task_draft !== undefined ? { task: input.task_draft } : {}),
          project_root: input.project_root,
        };
  const parsed = parseDraftPackageBody(body);
  if ("ok" in parsed) {
    return textResult({ error: parsed.error, status: parsed.status }, true);
  }
  const root = input.project_root ?? deps.projectRoot ?? deps.cwd;
  const result = await validateDraftPackage(parsed, { cwd: root, projectRoot: root, strict: true });
  return textResult(result);
}

async function runValidateAgent(deps: McpToolDeps, input: ValidateInput) {
  const service = deps.agentService as AgentService | undefined;
  if (!service) return textResult({ error: "agentService unavailable", status: 503 }, true);
  const root = defaultAgentProjectRoot(deps.cwd);
  return textResult(await service.validate(root, input.definition!));
}

async function runValidateEval(deps: McpToolDeps, input: ValidateInput) {
  try {
    const { eval_id, yaml, path: evalPath, dataset_cases, project_root } = input;
    const rootOptions = { store: deps.store, bootCwd: deps.cwd };
    const datasetCases = optDatasetCases(dataset_cases as unknown[] | undefined);
    const located = eval_id !== undefined ? await locateEval(rootOptions, project_root, eval_id) : undefined;
    const projectRoot = located?.projectRoot ?? (await projectRootForEval(deps, project_root));
    let evalAbs: string;
    if (evalPath !== undefined) {
      evalAbs = path.resolve(projectRoot, evalPath);
      assertInsideProject(projectRoot, evalAbs, "eval path");
    } else if (located !== undefined) {
      evalAbs = located.ref.absPath;
    } else {
      const manifest = await manifestForWrite(projectRoot);
      const dir = await resolveWriteDir(projectRoot, manifest, "evals");
      const rawId = /^id:\s*["']?([A-Za-z0-9][A-Za-z0-9._-]{0,63})["']?\s*$/m.exec(yaml as string)?.[1];
      evalAbs = path.join(dir.absDir, `${rawId ?? "new"}.eval.yaml`);
      assertInsideProject(projectRoot, evalAbs, "eval path");
    }
    const derived =
      yaml !== undefined
        ? yaml.endsWith("\n")
          ? yaml
          : `${yaml}\n`
        : await readFile(located!.ref.absPath, "utf8");
    const { findings } = await validateEvalText({
      projectRoot,
      evalAbs,
      derived,
      ...(datasetCases !== undefined ? { datasetCases } : {}),
      ...(deps.agentService ? { agents: deps.agentService } : {}),
    });
    return textResult({ findings });
  } catch (err) {
    if (err instanceof EvalApiError) {
      return textResult({ error: err.message, code: err.code, status: err.status }, true);
    }
    if (err instanceof CatalogPathError) return textResult(catalogPathErrorBody(err), true);
    throw err;
  }
}

async function runValidateConnectionRecipient(deps: McpToolDeps, input: ValidateInput) {
  const channels = deps.channels as ChannelService | undefined;
  if (!channels) return textResult({ error: "CHANNELS_UNAVAILABLE" }, true);
  const { id, to, cc, template } = input;
  const target = {
    ...(to !== undefined ? { to } : {}),
    ...(cc !== undefined ? { cc } : {}),
    ...(template !== undefined ? { template } : {}),
  };
  return textResult(await channels.validateTarget(id!, Object.fromEntries(Object.entries(target).filter((e) => e[1] !== undefined))));
}

async function runValidatePreflight(deps: McpToolDeps, input: ValidateInput) {
  const { pipeline, project_root, strict } = input;
  const roots = await resolveCatalogRoots({ store: deps.store, bootCwd: deps.cwd });
  let loaded;
  let projectRoot: string;
  try {
    const wireRoot = selectCatalogRootForStart(roots, project_root);
    projectRoot = wireRoot.project_root;
    if (typeof pipeline === "string") {
      const resolved = resolveCatalogRelativePath({
        inputPath: pipeline,
        projectRoot: project_root,
        roots,
        fieldName: "pipeline",
      });
      projectRoot = resolved.root.project_root;
      const outcome = await loadPipelineOutcome(resolved.absolutePath, {
        cwd: deps.cwd,
        projectRoot,
      });
      if (!outcome.ok) {
        return textResult(
          {
            ok: false,
            error: outcome.issues[0]?.message ?? "pipeline load failed",
            code: outcome.issues[0]?.code ?? "config_invalid",
            issues: outcome.issues,
          },
          true,
        );
      }
      loaded = outcome.value;
    } else {
      const outcome = await loadPipelineFromObjectOutcome(pipeline!, {
        cwd: deps.cwd,
        projectRoot: wireRoot.path,
      });
      if (!outcome.ok) {
        return textResult(
          {
            ok: false,
            error: outcome.issues[0]?.message ?? "pipeline load failed",
            code: outcome.issues[0]?.code ?? "config_invalid",
            issues: outcome.issues,
          },
          true,
        );
      }
      loaded = outcome.value;
      projectRoot = wireRoot.path;
    }
  } catch (err) {
    if (err instanceof CatalogPathError) return textResult(catalogPathErrorBody(err), true);
    throw err;
  }
  const result = await runPipelinePreflight(loaded, {
    projectRoot,
    strict: strict === true,
  });
  const code = preflightFailureCode(result, { strict: strict === true });
  return textResult({
    ok: result.ok,
    checks: result.checks,
    ...(code !== undefined ? { code } : {}),
  });
}

export async function runReadPipelineDag(deps: McpToolDeps, pipeline: string, project_root?: string) {
  if (!pipeline.trim()) {
    return textResult({ error: "path is required", status: 400 }, true);
  }
  try {
    const roots = await resolveCatalogRoots({ store: deps.store, bootCwd: deps.cwd });
    const resolved = resolveCatalogRelativePath({
      inputPath: pipeline.trim(),
      projectRoot: project_root,
      roots,
      fieldName: "path",
    });
    const loaded = await loadPipeline(resolved.absolutePath, {
      projectRoot: resolved.root.path,
    });
    return textResult(describePipeline(loaded));
  } catch (err) {
    if (err instanceof CatalogPathError) return textResult(catalogPathErrorBody(err), true);
    const message = err instanceof Error ? err.message : String(err);
    return textResult({ error: message, status: 400 }, true);
  }
}
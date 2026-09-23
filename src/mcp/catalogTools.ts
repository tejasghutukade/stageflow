import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  catalogPathErrorBody,
  CatalogPathError,
  resolveCatalogRelativePath,
} from "../config/catalogRelativePath.js";
import {
  listModelsMultiProject,
  listPipelinesMultiProject,
  listTasksMultiProject,
} from "../config/multiProjectCatalog.js";
import { resolveCatalogRoots } from "../config/resolveCatalogRoots.js";
import { describePipeline } from "../config/describePipeline.js";
import { loadPipeline } from "../config/loadPipeline.js";
import { readYamlObject } from "../config/readYamlObject.js";
import { validateCatalog, type ValidationResult } from "../config/validateCatalog.js";
import { writeAudit } from "../logging/audit.js";
import { logger as rootLogger } from "../logging/logger.js";
import { PACKAGE_VERSION, BUILD_SHA } from "../package-meta.js";
import type { ListRunsFilter, RunStatus } from "../runstore/port.js";
import { PipelineValidationError } from "../runtime/pipelineValidationError.js";
import { PipelinePreflightError } from "../runtime/pipelineRunner.js";
import {
  EnvelopeRefError,
  resolveEnvelopeRefsToTask,
} from "../runtime/resolveEnvelopeRef.js";
import type { InlinePipelineDefinition } from "../types/pipeline.js";
import { isTerminalProjection, isWaitingProjection, waitRun } from "./waitRun.js";
import { mapStoreLookupError } from "../server/operatorResults.js";
import {
  callerIdFromRequestAuth,
  getRequestAuth,
} from "../server/requestAuthContext.js";
import type { McpToolDeps } from "./deps.js";
import { projectRunForMcp } from "./projectRun.js";
import { classifyArtifactContent, readRunArtifactBytes } from "./readArtifact.js";
import { imageResult, textResult } from "./toolResults.js";
import { buildRunExportPayload } from "../runstore/exportRunPayload.js";
import { redactRunManifestForRead } from "../runstore/runManifest.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runSkillsDir } from "../runtime/runSkills.js";
import { listSkillsWithOrigin } from "../config/listSkills.js";
import {
  findTokenShapedField,
  pickCheckoutOverride,
  tokenRejectedPayload,
} from "../runtime/startPayload.js";
import {
  loadPipelineFromObjectOutcome,
  loadPipelineOutcome,
} from "../config/loadPipeline.js";
import {
  preflightFailureCode,
  runPipelinePreflight,
} from "../preflight/pipelinePreflight.js";
import { toolchainHealthMap } from "../preflight/toolchain.js";

const auditLog = rootLogger.child({ component: "audit" });

const gitIdentitySchema = z
  .object({
    name: z.string().optional(),
    email: z.string().optional(),
  })
  .strict();

const taskFileSchema = z.object({
  id: z.string(),
  goal: z.string(),
  context: z.string().optional(),
  constraints: z.string().optional(),
  checkout: z.string().optional(),
  repository: z.string().optional(),
  ref: z.string().optional(),
  run_branch_template: z.string().optional(),
  git_identity: gitIdentitySchema.optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Deliberately thin: only enough shape to route to the inline-pipeline
 * loader. Real structural validation (required io schemas, DAG shape, stage
 * id uniqueness) happens downstream through the same validator a file-based
 * pipeline goes through, so a caller gets the same ValidationFinding-shaped
 * error either way instead of a raw schema-validation error.
 */
const inlinePipelineSchema = z
  .object({
    id: z.string().min(1),
    stages: z.array(z.record(z.string(), z.unknown())).min(1),
    agent: z.unknown().optional(),
    model: z.unknown().optional(),
    schemas: z.unknown().optional(),
    requires: z.unknown().optional(),
  })
  .strict();

const startRunSchema = z
  .object({
    pipeline: z
      .union([z.string(), inlinePipelineSchema])
      .describe(
        "Catalog-relative pipeline path, or an inline pipeline definition object ({ id, stages: [...] }) authored directly in this call",
      ),
    task_path: z.string().optional(),
    task: taskFileSchema.optional(),
    project_root: z.string().optional(),
    checkout: z
      .string()
      .optional()
      .describe(
        "Catalog-relative checkout path (maps to RunManager checkoutOverride); absolute paths are rejected with absolute_path_not_allowed",
      ),
    checkout_override: z
      .string()
      .optional()
      .describe("Alias of checkout; prefer checkout"),
    skip_gates: z.boolean().optional(),
    git_sha: z.string().optional(),
    ci_pr_url: z.string().optional(),
    ci_job_url: z.string().optional(),
    skills: z
      .record(z.string(), z.record(z.string(), z.string()))
      .optional()
      .describe(
        "Run-scoped skills: name → { relativePath: utf-8 contents }. Requires SKILL.md per name; materialised under the run workspace skills dir (never the worktree)",
      ),
  })
  .passthrough()
  .refine((data) => Boolean(data.task_path) !== Boolean(data.task), {
    message: "Exactly one of task_path or task is required",
  });

/**
 * Deliberately thin, same reasoning as inlinePipelineSchema above: real
 * structural validation of the stage body happens downstream through the
 * same stage loader a pipeline's inline stage goes through.
 */
const envelopeRefSchema = z.object({
  runId: z.string(),
  stageId: z.string(),
  attempt: z.number().int().positive().optional(),
});

const runStageSchema = z
  .object({
    stage: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .describe(
        "Filesystem path to a stage YAML file, or a bare inline stage body object ({ id, system_prompt, io, model?, gate_kinds?, mcp?, verify?, timeout_ms? } — no uses:/route/pipeline wrapper) authored directly in this call",
      ),
    task_path: z.string().optional(),
    task: taskFileSchema.optional(),
    envelope_ref: z
      .union([envelopeRefSchema, z.array(envelopeRefSchema).min(1)])
      .optional()
      .describe(
        "Resolve one or more previously stored StageEnvelopes (from another run_stage call or from any stage inside a full pipeline run) and use them as this stage's input, instead of an inline task/task_path. A single ref: its payload becomes input, its summary becomes goal. Multiple refs (an array): each resolved payload is namespaced under its stageId in input (disambiguated by runId on a stageId collision), and summaries are combined into goal.",
      ),
    checkout: z
      .string()
      .optional()
      .describe(
        "Optional checkout to use with envelope_ref (ignored with task/task_path, which carry their own checkout). Resolving envelope_ref never implies a checkout on its own.",
      ),
    model: z
      .string()
      .optional()
      .describe(
        "Override the model/backend for this call only, taking precedence over the stage's own declared model and the global default. Omit to use the stage's own model (or the global default).",
      ),
    blocking: z
      .boolean()
      .optional()
      .describe(
        "When true, wait for the run to reach a terminal or waiting state and return the result in this same call, instead of returning immediately with just { runId }",
      ),
    timeout_ms: z
      .number()
      .optional()
      .describe("Wait budget in ms when blocking is true (same bounds as wait_run)"),
  })
  .refine(
    (data) => [data.task_path, data.task, data.envelope_ref].filter(Boolean).length === 1,
    { message: "Exactly one of task_path, task, or envelope_ref is required" },
  );

const runStatusSchema = z.enum([
  "created",
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export function registerCatalogTools(server: McpServer, deps: McpToolDeps): void {
  const { manager, store, cwd } = deps;
  const agentDir = deps.agentDir ?? getAgentDir();

  server.registerTool(
    "list_skills",
    {
      description:
        "List skills with name, description, and origin (run|checkout|host). Optional runId scopes to that run's resolution view (run-tier skills first, then checkout .pi/skills, then host).",
      inputSchema: z.object({
        runId: z.string().optional(),
      }),
    },
    async ({ runId }) => {
      try {
        let runSkills: string | undefined;
        let checkoutRoot: string | undefined;
        if (runId !== undefined) {
          const meta = await store.readRunMeta(runId);
          runSkills = runSkillsDir(store.getWorkspaceDir(runId));
          checkoutRoot = meta.checkout_root;
        }
        const catalog = await listSkillsWithOrigin({
          cwd,
          agentDir,
          ...(runSkills !== undefined ? { runSkillsDir: runSkills } : {}),
          ...(checkoutRoot !== undefined ? { checkoutRoot } : {}),
        });
        return textResult({
          skills: catalog.skills,
          diagnostics: catalog.diagnostics,
        });
      } catch (err) {
        if (runId !== undefined) {
          const mapped = mapStoreLookupError(err, { policy: "run" });
          return textResult(
            { error: mapped.error, status: mapped.status },
            true,
          );
        }
        throw err;
      }
    },
  );

  server.registerTool(
    "list_pipelines",
    {
      description:
        "List manifest-declared pipeline paths across every project this host knows about (boot cwd, registered store roots, and seeded roots). Each entry is tagged with project_root. Optional project_root filter narrows; unknown value returns unknown_project_root.",
      inputSchema: z.object({
        project_root: z.string().optional(),
      }),
    },
    async ({ project_root }) => {
      const result = await listPipelinesMultiProject({
        store,
        bootCwd: cwd,
        projectRootFilter: project_root,
      });
      if (
        result.root_errors.some((e) => e.code === "unknown_project_root") &&
        result.items.length === 0
      ) {
        return textResult(
          {
            error: result.root_errors[0]!.message,
            code: "unknown_project_root",
            root_errors: result.root_errors,
          },
          true,
        );
      }
      return textResult({
        pipelines: result.items,
        root_errors: result.root_errors,
      });
    },
  );

  server.registerTool(
    "list_tasks",
    {
      description:
        "List manifest-declared task paths across every project this host knows about (boot cwd, registered store roots, and seeded roots). Each entry is tagged with project_root. Optional project_root filter narrows; unknown value returns unknown_project_root.",
      inputSchema: z.object({
        project_root: z.string().optional(),
      }),
    },
    async ({ project_root }) => {
      const result = await listTasksMultiProject({
        store,
        bootCwd: cwd,
        projectRootFilter: project_root,
      });
      if (
        result.root_errors.some((e) => e.code === "unknown_project_root") &&
        result.items.length === 0
      ) {
        return textResult(
          {
            error: result.root_errors[0]!.message,
            code: "unknown_project_root",
            root_errors: result.root_errors,
          },
          true,
        );
      }
      return textResult({
        tasks: result.items,
        root_errors: result.root_errors,
      });
    },
  );

  server.registerTool(
    "list_models",
    {
      description:
        "List catalog model ids across every project this host knows about (same multi-root source as GET /api/models). Optional project_root filter narrows.",
      inputSchema: z.object({
        project_root: z.string().optional(),
      }),
    },
    async ({ project_root }) => {
      const result = await listModelsMultiProject({
        store,
        bootCwd: cwd,
        projectRootFilter: project_root,
      });
      if (
        result.root_errors.some((e) => e.code === "unknown_project_root") &&
        result.items.length === 0
      ) {
        return textResult(
          {
            error: result.root_errors[0]!.message,
            code: "unknown_project_root",
            root_errors: result.root_errors,
          },
          true,
        );
      }
      return textResult({
        models: result.models,
        entries: result.items,
        root_errors: result.root_errors,
      });
    },
  );

  server.registerTool(
    "list_runs",
    {
      description:
        "List known pipeline runs. Optional filters: status, since (ISO created_at lower bound), pipeline (id or path), caller_id.",
      inputSchema: z.object({
        status: runStatusSchema.optional(),
        since: z.string().optional(),
        pipeline: z.string().optional(),
        caller_id: z.string().optional(),
      }),
    },
    async ({ status, since, pipeline, caller_id }) => {
      const filter: ListRunsFilter = {};
      if (status !== undefined) filter.status = status as RunStatus;
      if (since !== undefined) {
        if (!Number.isFinite(Date.parse(since))) {
          return textResult({ error: "since must be a valid date", status: 400 }, true);
        }
        filter.since = since;
      }
      if (pipeline !== undefined) filter.pipeline = pipeline;
      if (caller_id !== undefined) filter.caller_id = caller_id;
      const runs = await store.listRuns(
        Object.keys(filter).length > 0 ? filter : undefined,
      );
      return textResult({ runs });
    },
  );

  server.registerTool(
    "get_health",
    {
      description:
        "Server health and soft-max run capacity: activeRunIds, activeCount, maxConcurrent, slotsAvailable, activeStageProcesses, version, plus disk breakdown (disk.runs_bytes, worktrees_bytes, repos_bytes, state_db_bytes, a2a_artifacts_bytes, free_bytes) for the durable root. Start until slotsAvailable is 0; then wait for a run to finish or raise STAGEFLOW_MAX_CONCURRENT_RUNS.",
      inputSchema: z.object({}),
    },
    async () =>
      textResult({
        ...(await manager.getHealthWithDisk()),
        version: PACKAGE_VERSION,
        build_sha: BUILD_SHA,
        toolchain: toolchainHealthMap(),
      }),
  );

  server.registerTool(
    "preflight",
    {
      description:
        "Check pipeline requires:/secrets:/mcp against the Host toolchain manifest and curated stage env before start_run. Accepts pipeline path or inline definition (same union as start_run). Returns { ok, checks } with status ok|missing_tool|tool_version_mismatch|unknown_version|secret_unavailable|unresolved_var. Does not create a Run. unknown_version is ok unless strict:true.",
      inputSchema: z.object({
        pipeline: z
          .union([z.string(), inlinePipelineSchema])
          .describe(
            "Catalog-relative pipeline path, or an inline pipeline definition object",
          ),
        project_root: z.string().optional(),
        strict: z
          .boolean()
          .optional()
          .describe("When true, unknown_version fails (default false)"),
      }),
    },
    async ({ pipeline, project_root, strict }) => {
      const roots = await resolveCatalogRoots({
        store: deps.store,
        bootCwd: deps.cwd,
      });
      let projectRoot = project_root ?? deps.cwd;
      let loaded;
      try {
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
          const outcome = await loadPipelineFromObjectOutcome(pipeline, {
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
        }
      } catch (err) {
        if (err instanceof CatalogPathError) {
          return textResult(catalogPathErrorBody(err), true);
        }
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
    },
  );

  server.registerTool(
    "start_run",
    {
      description:
        "Start a pipeline run. Accepted params: pipeline (catalog-relative path or inline { id, stages: [...] } — stages are YAML stage bodies, no uses: refs), task_path XOR task (inline task may include repository/ref or checkout; repository XOR checkout with code task.binding_conflict), project_root, checkout (catalog-relative; prefer this name; absolute → absolute_path_not_allowed), checkout_override (alias of checkout), skip_gates, git_sha, ci_pr_url, ci_job_url, skills (name → { relativePath: utf-8 contents }; requires SKILL.md; materialised under runs/<runId>/skills/, never the worktree). REST POST /api/runs accepts path pipelines only (no inline pipeline). Returns { runId } or { runId, queued: true, queuePosition }. Errors: busy_capacity, busy_checkout, insufficient_disk, start.token_rejected, skills_*, inline_pipeline_too_large, catalog path-contract codes.",
      inputSchema: startRunSchema,
    },
    async (args) => {
      const tokenField = findTokenShapedField(args);
      if (tokenField !== undefined) {
        return textResult(tokenRejectedPayload(tokenField), true);
      }
      const {
        pipeline,
        task_path,
        task,
        project_root,
        checkout,
        checkout_override,
        skip_gates,
        git_sha,
        ci_pr_url,
        ci_job_url,
        skills,
      } = args;
      if (typeof pipeline === "string" && !pipeline.trim()) {
        return textResult({ error: "pipeline is required" }, true);
      }
      const taskInput = task_path ?? task;
      if (taskInput === undefined) {
        return textResult({ error: "Exactly one of task_path or task is required" }, true);
      }
      const roots = await resolveCatalogRoots({
        store: deps.store,
        bootCwd: deps.cwd,
      });
      let resolvedPipeline: typeof pipeline = pipeline;
      let resolvedTask: typeof taskInput = taskInput;
      let resolvedCheckout: string | undefined;
      try {
        if (typeof pipeline === "string") {
          resolvedPipeline = resolveCatalogRelativePath({
            inputPath: pipeline,
            projectRoot: project_root,
            roots,
            fieldName: "pipeline",
          }).absolutePath;
        }
        if (typeof task_path === "string") {
          resolvedTask = resolveCatalogRelativePath({
            inputPath: task_path,
            projectRoot: project_root,
            roots,
            fieldName: "task_path",
          }).absolutePath;
        }
        const rawCheckout = pickCheckoutOverride({ checkout, checkout_override });
        if (rawCheckout !== undefined) {
          resolvedCheckout = resolveCatalogRelativePath({
            inputPath: rawCheckout,
            projectRoot: project_root,
            roots,
            fieldName: "checkout",
          }).absolutePath;
        }
      } catch (err) {
        if (err instanceof CatalogPathError) {
          return textResult(catalogPathErrorBody(err), true);
        }
        throw err;
      }
      const callerId = callerIdFromRequestAuth();
      let result;
      try {
        result = await manager.startRun({
          pipeline: resolvedPipeline,
          task: resolvedTask,
          ...(resolvedCheckout !== undefined
            ? { checkoutOverride: resolvedCheckout }
            : {}),
          ...(skip_gates !== undefined ? { skipGates: skip_gates } : {}),
          ...(git_sha !== undefined ? { gitSha: git_sha } : {}),
          ...(ci_pr_url !== undefined ? { ciPrUrl: ci_pr_url } : {}),
          ...(ci_job_url !== undefined ? { ciJobUrl: ci_job_url } : {}),
          ...(skills !== undefined ? { skills } : {}),
          callerId,
        });
      } catch (err) {
        if (err instanceof PipelineValidationError) {
          writeAudit(auditLog, {
            caller_id: callerId,
            surface: getRequestAuth()?.surface ?? "mcp",
            action: "start_run",
            outcome: "error",
            error_code: "pipeline_validation",
          });
          return textResult(
            { error: "Pipeline validation failed", validation: err.result },
            true,
          );
        }
        if (err instanceof PipelinePreflightError) {
          writeAudit(auditLog, {
            caller_id: callerId,
            surface: getRequestAuth()?.surface ?? "mcp",
            action: "start_run",
            outcome: "error",
            error_code: err.code,
          });
          return textResult(err.toNetworkBody(), true);
        }
        throw err;
      }
      if (!result.ok) {
        writeAudit(auditLog, {
          caller_id: callerId,
          surface: getRequestAuth()?.surface ?? "mcp",
          action: "start_run",
          outcome: "error",
          error_code: result.code,
        });
        const { ok: _ok, reason, ...rest } = result;
        return textResult({ error: reason, ...rest }, true);
      }
      writeAudit(auditLog, {
        caller_id: callerId,
        surface: getRequestAuth()?.surface ?? "mcp",
        action: "start_run",
        target_run_id: result.runId,
        outcome: "ok",
      });
      return textResult({
        runId: result.runId,
        ...(result.queued === true
          ? {
              queued: true,
              queuePosition: result.queuePosition,
              ...(result.queuedCode !== undefined
                ? { queuedCode: result.queuedCode }
                : {}),
            }
          : {}),
      });
    },
  );

  server.registerTool(
    "run_stage",
    {
      description:
        "Run a single stage directly, without authoring a pipeline. `stage` is a filesystem path to a stage YAML file, or a bare inline stage body ({ id, system_prompt, io, model?, gate_kinds?, mcp?, verify?, timeout_ms? } — no uses:/route/pipeline wrapper), and exactly one of task_path, an inline task, or envelope_ref ({ runId, stageId, attempt? }) to resolve a previously stored envelope — from another run_stage call or any stage in a full pipeline run — as this stage's input. Internally this synthesizes a one-stage pipeline and executes it through the normal run path, so it shows up in list_runs/get_run and is polled with wait_run / get_envelope exactly like any other run. By default returns { runId, stageId } immediately (async); pass blocking:true to wait in this same call and get back { runId, stageId, status: \"completed\"|\"needs_input\"|\"timeout\", envelope? , pending_prompt? }.",
      inputSchema: runStageSchema,
    },
    async ({ stage, task_path, task, envelope_ref, checkout, model, blocking, timeout_ms }) => {
      let taskInput: string | z.infer<typeof taskFileSchema> | undefined = task_path ?? task;
      if (envelope_ref) {
        try {
          taskInput = await resolveEnvelopeRefsToTask(store, envelope_ref, checkout);
        } catch (err) {
          if (err instanceof EnvelopeRefError) {
            return textResult({ error: err.message, status: err.status }, true);
          }
          throw err;
        }
      }
      if (taskInput === undefined) {
        return textResult(
          { error: "Exactly one of task_path, task, or envelope_ref is required" },
          true,
        );
      }

      let stageBody: Record<string, unknown>;
      if (typeof stage === "string") {
        if (!stage.trim()) {
          return textResult({ error: "stage is required" }, true);
        }
        const absPath = path.resolve(cwd, stage);
        try {
          stageBody = await readYamlObject(absPath);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return textResult({ error: `Failed to read stage file: ${message}` }, true);
        }
      } else {
        stageBody = stage;
      }

      if (typeof stageBody.id !== "string" || !stageBody.id.trim()) {
        return textResult({ error: "stage.id is required" }, true);
      }
      const stageId = stageBody.id;
      // A call-level model override wins over both the stage's own declared
      // model and the global default: it replaces the field the stage body
      // itself would otherwise resolve through, rather than adding a new
      // tier to resolveModel's stage > pipeline > global chain.
      const effectiveStageBody = model !== undefined ? { ...stageBody, model } : stageBody;

      const pipeline: InlinePipelineDefinition = {
        id: `standalone-${stageId}`,
        stages: [effectiveStageBody],
      };

      let result;
      try {
        result = await manager.startRun({ pipeline, task: taskInput });
      } catch (err) {
        if (err instanceof PipelineValidationError) {
          return textResult(
            { error: "Stage validation failed", validation: err.result },
            true,
          );
        }
        throw err;
      }
      if (!result.ok) {
        const { ok: _ok, reason, ...rest } = result;
        return textResult({ error: reason, ...rest }, true);
      }
      const runId = result.runId;
      if (!blocking) {
        return textResult({ runId, stageId });
      }

      const waited = await waitRun({ store, runId, timeoutMs: timeout_ms, until: "any" });
      if (!waited.ok) {
        return textResult(
          {
            error: waited.error,
            ...(waited.status !== undefined ? { status: waited.status } : {}),
            ...(waited.code !== undefined ? { code: waited.code } : {}),
          },
          true,
        );
      }
      const stageProjection = waited.run.stages.find((s) => s.stage_id === stageId);
      if (isTerminalProjection(waited.run)) {
        return textResult({
          runId,
          stageId,
          status: "completed",
          envelope: stageProjection?.envelope ?? null,
        });
      }
      if (isWaitingProjection(waited.run)) {
        return textResult({
          runId,
          stageId,
          status: "needs_input",
          pending_prompt: stageProjection?.pending_prompt,
          waiting_kind: waited.run.waiting_kind,
          waiting_prompt_id: waited.run.waiting_prompt_id,
          waiting_summary: waited.run.waiting_summary,
        });
      }
      return textResult({ runId, stageId, status: "timeout" });
    },
  );

  server.registerTool(
    "get_run",
    {
      description:
        "Poll a run: status, stage statuses, waiting_* / pending_prompt HITL fields, and envelope summary/payload/artifact paths (no events). Use list_stage_events, get_envelope, or get_stage_verification for stage detail.",
      inputSchema: z.object({
        runId: z.string(),
      }),
    },
    async ({ runId }) => {
      try {
        const detail = await store.readRun(runId);
        return textResult({
          ...projectRunForMcp(detail),
          run_manifest: redactRunManifestForRead(detail.run_manifest),
        });
      } catch (err) {
        const mapped = mapStoreLookupError(err, { policy: "run" });
        return textResult(
          { error: mapped.error, status: mapped.status },
          true,
        );
      }
    },
  );

  server.registerTool(
    "export_run",
    {
      description:
        "Export a single run as projectRun projection plus run_manifest. Works for running, cancelled, and terminal runs. Prefer over CLI sf export-run when the Host is reachable.",
      inputSchema: z.object({
        runId: z.string(),
      }),
    },
    async ({ runId }) => {
      try {
        const detail = await store.readRun(runId);
        return textResult(buildRunExportPayload(detail));
      } catch (err) {
        const mapped = mapStoreLookupError(err, { policy: "run" });
        return textResult(
          { error: mapped.error, status: mapped.status },
          true,
        );
      }
    },
  );

  server.registerTool(
    "read_artifact",
    {
      description:
        "Read a run-workspace artifact by relative path (contained under the run workspace). Known image extensions (png, jpeg, gif, webp) return an MCP image content block. UTF-8 text returns JSON { runId, path, content }. Non-UTF-8 non-image files return isError 400.",
      inputSchema: z.object({
        runId: z.string(),
        path: z.string(),
      }),
    },
    async ({ runId, path: artifactPath }) => {
      try {
        const bytes = await readRunArtifactBytes(store, runId, artifactPath);
        const classified = classifyArtifactContent(artifactPath, bytes);
        if (classified.kind === "image") {
          return imageResult(classified.mimeType, bytes, {
            runId,
            path: artifactPath,
            mimeType: classified.mimeType,
          });
        }
        if (classified.kind === "utf8") {
          return textResult({
            runId,
            path: artifactPath,
            content: bytes.toString("utf8"),
          });
        }
        return textResult(
          { error: "Artifact is not valid UTF-8 text", status: 400 },
          true,
        );
      } catch (err) {
        const mapped = mapStoreLookupError(err, { policy: "artifact" });
        return textResult(
          { error: mapped.error, status: mapped.status },
          true,
        );
      }
    },
  );

  server.registerTool(
    "validate",
    {
      description:
        "Validate the project catalog (full), a pipeline path, or a task path. Returns ValidationResult JSON (ok, summary, findings).",
      inputSchema: z.object({
        pipeline: z.string().optional(),
        task: z.string().optional(),
        strict: z.boolean().optional(),
      }),
    },
    async ({ pipeline, task, strict }) => {
      try {
        let scope: "full" | "pipeline" | "task" = "full";
        if (pipeline !== undefined && pipeline.trim()) scope = "pipeline";
        else if (task !== undefined && task.trim()) scope = "task";

        if (scope === "full") {
          const roots = await resolveCatalogRoots({
            store: deps.store,
            bootCwd: deps.cwd,
          });
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
              // unreadable root; skip
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
        }

        const target = scope === "pipeline" ? pipeline!.trim() : task!.trim();
        const roots = await resolveCatalogRoots({
          store: deps.store,
          bootCwd: deps.cwd,
        });
        let resolvedTarget = target;
        let projectRoot = deps.cwd;
        try {
          const resolved = resolveCatalogRelativePath({
            inputPath: target,
            roots,
            fieldName: scope === "pipeline" ? "pipeline" : "task",
          });
          resolvedTarget = resolved.absolutePath;
          projectRoot = resolved.root.path;
        } catch (err) {
          if (err instanceof CatalogPathError) {
            return textResult(catalogPathErrorBody(err), true);
          }
          throw err;
        }
        const result = await validateCatalog({
          cwd: projectRoot,
          scope,
          projectRoot,
          ...(scope === "pipeline" ? { pipeline: resolvedTarget } : {}),
          ...(scope === "task" ? { task: resolvedTarget } : {}),
          strict: strict ?? false,
        });
        return textResult(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult({ error: message, status: 400 }, true);
      }
    },
  );

  server.registerTool(
    "describe_pipeline",
    {
      description:
        "Describe a pipeline DAG from a catalog-relative path (same path contract as start_run): stages with inbound needs (id, on, optional if), fork, gate_kinds, Clone Chain clone_cap and clone_mode, and feedback_loop, entry, and replay_safe when set.",
      inputSchema: z.object({
        pipeline: z.string(),
        project_root: z.string().optional(),
      }),
    },
    async ({ pipeline, project_root }) => {
      if (!pipeline.trim()) {
        return textResult({ error: "pipeline is required", status: 400 }, true);
      }
      try {
        const roots = await resolveCatalogRoots({
          store: deps.store,
          bootCwd: deps.cwd,
        });
        const resolved = resolveCatalogRelativePath({
          inputPath: pipeline.trim(),
          projectRoot: project_root,
          roots,
          fieldName: "pipeline",
        });
        const loaded = await loadPipeline(resolved.absolutePath, {
          projectRoot: resolved.root.path,
        });
        return textResult(describePipeline(loaded));
      } catch (err) {
        if (err instanceof CatalogPathError) {
          return textResult(catalogPathErrorBody(err), true);
        }
        const message = err instanceof Error ? err.message : String(err);
        return textResult({ error: message, status: 400 }, true);
      }
    },
  );
}

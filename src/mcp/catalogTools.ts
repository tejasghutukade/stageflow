import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  browseCatalog,
  type PipelineListing,
  type TaskListing,
} from "../config/browseCatalog.js";
import { describePipeline } from "../config/describePipeline.js";
import { loadPipeline } from "../config/loadPipeline.js";
import { validateCatalog, type ValidationResult } from "../config/validateCatalog.js";
import { PACKAGE_VERSION } from "../package-meta.js";
import { findProjectRoot } from "../project/findProjectRoot.js";
import type { ListRunsFilter, RunStatus } from "../runstore/port.js";
import { PipelineValidationError } from "../runtime/pipelineValidationError.js";
import { mapStoreLookupError } from "../server/operatorResults.js";
import type { McpToolDeps } from "./deps.js";
import { projectRunForMcp } from "./projectRun.js";
import { classifyArtifactContent, readRunArtifactBytes } from "./readArtifact.js";
import { imageResult, textResult } from "./toolResults.js";
import {
  findTokenShapedField,
  tokenRejectedPayload,
} from "../runtime/startPayload.js";

/**
 * Every project a host serving a global store has ever recorded a run for,
 * plus this host's own launch directory (always included so a project with
 * zero runs yet still sees its own catalog).
 */
async function catalogRootsFor(deps: McpToolDeps): Promise<string[]> {
  const known = await deps.store.listProjectRoots();
  return [...new Set([...known, deps.cwd])];
}

/** Resolve which project a given catalog path (pipeline/task) belongs to. */
function projectRootForPath(deps: McpToolDeps, catalogPath: string): string {
  const absDir = path.dirname(path.resolve(deps.cwd, catalogPath));
  return findProjectRoot(absDir) ?? deps.cwd;
}

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
  })
  .strict();

const startRunSchema = z
  .object({
    pipeline: z
      .union([z.string(), inlinePipelineSchema])
      .describe(
        "Filesystem path to a pipeline YAML file, or an inline pipeline definition object ({ id, stages: [...] }) authored directly in this call",
      ),
    task_path: z.string().optional(),
    task: taskFileSchema.optional(),
    checkout_override: z.string().optional(),
    skip_gates: z.boolean().optional(),
    git_sha: z.string().optional(),
    ci_pr_url: z.string().optional(),
    ci_job_url: z.string().optional(),
  })
  .passthrough()
  .refine((data) => Boolean(data.task_path) !== Boolean(data.task), {
    message: "Exactly one of task_path or task is required",
  });

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

  server.registerTool(
    "list_pipelines",
    {
      description:
        "List manifest-declared pipeline paths across every project this host knows about (this host's own project plus any project a run has ever been recorded for). Each entry is tagged with project_root. A project with no runs yet won't appear until its first run exists.",
      inputSchema: z.object({}),
    },
    async () => {
      const roots = await catalogRootsFor(deps);
      const pipelines: Array<PipelineListing & { project_root: string }> = [];
      for (const root of roots) {
        try {
          const catalog = await browseCatalog(root);
          for (const p of catalog.pipelines) {
            pipelines.push({ ...p, project_root: root });
          }
        } catch {
          // stale/unreadable project root recorded on an old run; skip it
        }
      }
      return textResult({ pipelines });
    },
  );

  server.registerTool(
    "list_tasks",
    {
      description:
        "List manifest-declared task paths across every project this host knows about (this host's own project plus any project a run has ever been recorded for). Each entry is tagged with project_root. A project with no runs yet won't appear until its first run exists.",
      inputSchema: z.object({}),
    },
    async () => {
      const roots = await catalogRootsFor(deps);
      const tasks: Array<TaskListing & { project_root: string }> = [];
      for (const root of roots) {
        try {
          const catalog = await browseCatalog(root);
          for (const t of catalog.tasks) {
            tasks.push({ ...t, project_root: root });
          }
        } catch {
          // stale/unreadable project root recorded on an old run; skip it
        }
      }
      return textResult({ tasks });
    },
  );

  server.registerTool(
    "list_models",
    {
      description:
        "List catalog model ids from the project catalog (same source as GET /api/models)",
      inputSchema: z.object({}),
    },
    async () => {
      const catalog = await browseCatalog(cwd);
      return textResult({ models: catalog.models });
    },
  );

  server.registerTool(
    "list_runs",
    {
      description:
        "List known pipeline runs. Optional filters: status, since (ISO created_at lower bound), pipeline (id or path).",
      inputSchema: z.object({
        status: runStatusSchema.optional(),
        since: z.string().optional(),
        pipeline: z.string().optional(),
      }),
    },
    async ({ status, since, pipeline }) => {
      const filter: ListRunsFilter = {};
      if (status !== undefined) filter.status = status as RunStatus;
      if (since !== undefined) {
        if (!Number.isFinite(Date.parse(since))) {
          return textResult({ error: "since must be a valid date", status: 400 }, true);
        }
        filter.since = since;
      }
      if (pipeline !== undefined) filter.pipeline = pipeline;
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
      textResult({ ...(await manager.getHealthWithDisk()), version: PACKAGE_VERSION }),
  );

  server.registerTool(
    "start_run",
    {
      description:
        "Start a pipeline run using a filesystem pipeline path or an inline pipeline definition ({ id, stages: [...] }, each stage the same shape as a YAML stage body — no uses: refs), and either task_path (catalog task file) or an inline task object (optional repository/ref binding). Optional checkout_override, skip_gates, git_sha, ci_pr_url, ci_job_url match REST. Returns { runId } or { runId, queued: true, queuePosition } when admitted to the queue. On conflict returns isError with code busy_capacity (admission queue full) or busy_checkout (path-checkout lease only; never queued), plus activeCount/maxConcurrent/activeRunIds and optional conflictingRunId/conflictingCheckout. Below STAGEFLOW_MIN_FREE_DISK_BYTES returns isError with code insufficient_disk (distinct from busy_capacity) plus freeBytes and minFreeBytes — the run is not queued. Token-shaped fields are rejected with start.token_rejected.",
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
        checkout_override,
        skip_gates,
        git_sha,
        ci_pr_url,
        ci_job_url,
      } = args;
      if (typeof pipeline === "string" && !pipeline.trim()) {
        return textResult({ error: "pipeline is required" }, true);
      }
      const taskInput = task_path ?? task;
      if (taskInput === undefined) {
        return textResult({ error: "Exactly one of task_path or task is required" }, true);
      }
      let result;
      try {
        result = await manager.startRun({
          pipeline,
          task: taskInput,
          ...(checkout_override !== undefined
            ? { checkoutOverride: checkout_override }
            : {}),
          ...(skip_gates !== undefined ? { skipGates: skip_gates } : {}),
          ...(git_sha !== undefined ? { gitSha: git_sha } : {}),
          ...(ci_pr_url !== undefined ? { ciPrUrl: ci_pr_url } : {}),
          ...(ci_job_url !== undefined ? { ciJobUrl: ci_job_url } : {}),
        });
      } catch (err) {
        if (err instanceof PipelineValidationError) {
          return textResult(
            { error: "Pipeline validation failed", validation: err.result },
            true,
          );
        }
        throw err;
      }
      if (!result.ok) {
        const { ok: _ok, reason, ...rest } = result;
        return textResult({ error: reason, ...rest }, true);
      }
      return textResult({
        runId: result.runId,
        ...(result.queued === true
          ? { queued: true, queuePosition: result.queuePosition }
          : {}),
      });
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
        return textResult(projectRunForMcp(detail));
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
          const roots = await catalogRootsFor(deps);
          const results: ValidationResult[] = [];
          for (const root of roots) {
            try {
              results.push(
                await validateCatalog({ cwd: root, scope: "full", strict: strict ?? false }),
              );
            } catch {
              // stale/unreadable project root recorded on an old run; skip it
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
        const projectRoot = projectRootForPath(deps, target);
        const result = await validateCatalog({
          cwd: projectRoot,
          scope,
          projectRoot,
          ...(scope === "pipeline" ? { pipeline: target } : {}),
          ...(scope === "task" ? { task: target } : {}),
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
        "Describe a pipeline DAG from a filesystem path (same as start_run): stages with inbound needs (id, on, optional if), fork, gate_kinds, Clone Chain clone_cap and clone_mode, and feedback_loop, entry, and replay_safe when set.",
      inputSchema: z.object({
        pipeline: z.string(),
      }),
    },
    async ({ pipeline }) => {
      if (!pipeline.trim()) {
        return textResult({ error: "pipeline is required", status: 400 }, true);
      }
      try {
        const loaded = await loadPipeline(pipeline.trim(), {
          cwd: projectRootForPath(deps, pipeline.trim()),
        });
        return textResult(describePipeline(loaded));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult({ error: message, status: 404 }, true);
      }
    },
  );
}

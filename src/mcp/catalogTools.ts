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
import { readYamlObject } from "../config/readYamlObject.js";
import { validateCatalog, type ValidationResult } from "../config/validateCatalog.js";
import { PACKAGE_VERSION } from "../package-meta.js";
import { findProjectRoot } from "../project/findProjectRoot.js";
import type { ListRunsFilter, RunStatus } from "../runstore/port.js";
import { PipelineValidationError } from "../runtime/pipelineValidationError.js";
import type { InlinePipelineDefinition } from "../types/pipeline.js";
import { isTerminalProjection, isWaitingProjection, waitRun } from "./waitRun.js";
import { mapStoreLookupError } from "../server/operatorResults.js";
import type { McpToolDeps } from "./deps.js";
import { projectRunForMcp } from "./projectRun.js";
import { classifyArtifactContent, readRunArtifactBytes } from "./readArtifact.js";
import { imageResult, textResult } from "./toolResults.js";

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

const taskFileSchema = z.object({
  id: z.string(),
  goal: z.string(),
  context: z.string().optional(),
  constraints: z.string().optional(),
  checkout: z.string().optional(),
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
  })
  .refine((data) => Boolean(data.task_path) !== Boolean(data.task), {
    message: "Exactly one of task_path or task is required",
  });

/**
 * Deliberately thin, same reasoning as inlinePipelineSchema above: real
 * structural validation of the stage body happens downstream through the
 * same stage loader a pipeline's inline stage goes through.
 */
const runStageSchema = z
  .object({
    stage: z
      .union([z.string(), z.record(z.string(), z.unknown())])
      .describe(
        "Filesystem path to a stage YAML file, or a bare inline stage body object ({ id, system_prompt, io, model?, gate_kinds?, mcp?, verify?, timeout_ms? } — no uses:/route/pipeline wrapper) authored directly in this call",
      ),
    task_path: z.string().optional(),
    task: taskFileSchema.optional(),
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
  .refine((data) => Boolean(data.task_path) !== Boolean(data.task), {
    message: "Exactly one of task_path or task is required",
  });

const runStatusSchema = z.enum(["created", "running", "succeeded", "failed"]);

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
        "Server health and soft-max run capacity: activeRunIds, activeCount, maxConcurrent, slotsAvailable, version. Start until slotsAvailable is 0; then wait for a run to finish or raise STAGEFLOW_MAX_CONCURRENT_RUNS.",
      inputSchema: z.object({}),
    },
    async () => textResult({ ...manager.getHealth(), version: PACKAGE_VERSION }),
  );

  server.registerTool(
    "start_run",
    {
      description:
        "Start a pipeline run using a filesystem pipeline path or an inline pipeline definition ({ id, stages: [...] }, each stage the same shape as a YAML stage body — no uses: refs), and either task_path (catalog task file) or an inline task object. Returns { runId }. On conflict returns isError with code busy_capacity (soft max full) or busy_checkout (same checkout leased), plus activeCount/maxConcurrent/activeRunIds and optional conflictingRunId/conflictingCheckout.",
      inputSchema: startRunSchema,
    },
    async ({ pipeline, task_path, task }) => {
      if (typeof pipeline === "string" && !pipeline.trim()) {
        return textResult({ error: "pipeline is required" }, true);
      }
      const taskInput = task_path ?? task;
      if (taskInput === undefined) {
        return textResult({ error: "Exactly one of task_path or task is required" }, true);
      }
      let result;
      try {
        result = await manager.startRun({ pipeline, task: taskInput });
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
      return textResult({ runId: result.runId });
    },
  );

  server.registerTool(
    "run_stage",
    {
      description:
        "Run a single stage directly, without authoring a pipeline. `stage` is a filesystem path to a stage YAML file, or a bare inline stage body ({ id, system_prompt, io, model?, gate_kinds?, mcp?, verify?, timeout_ms? } — no uses:/route/pipeline wrapper), and either task_path or an inline task. Internally this synthesizes a one-stage pipeline and executes it through the normal run path, so it shows up in list_runs/get_run and is polled with wait_run / get_envelope exactly like any other run. By default returns { runId, stageId } immediately (async); pass blocking:true to wait in this same call and get back { runId, stageId, status: \"completed\"|\"needs_input\"|\"timeout\", envelope? , pending_prompt? }.",
      inputSchema: runStageSchema,
    },
    async ({ stage, task_path, task, blocking, timeout_ms }) => {
      const taskInput = task_path ?? task;
      if (taskInput === undefined) {
        return textResult({ error: "Exactly one of task_path or task is required" }, true);
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

      const pipeline: InlinePipelineDefinition = {
        id: `standalone-${stageId}`,
        stages: [stageBody],
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

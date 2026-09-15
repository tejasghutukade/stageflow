import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { browseCatalog } from "../config/browseCatalog.js";
import { describePipeline } from "../config/describePipeline.js";
import { loadPipeline } from "../config/loadPipeline.js";
import { validateCatalog } from "../config/validateCatalog.js";
import type { ListRunsFilter, RunStatus } from "../runstore/port.js";
import type { McpToolDeps } from "./deps.js";
import { projectRunForMcp } from "./projectRun.js";
import { classifyArtifactContent, readRunArtifactBytes } from "./readArtifact.js";
import { imageResult, textResult } from "./toolResults.js";

const taskFileSchema = z.object({
  id: z.string(),
  goal: z.string(),
  context: z.string().optional(),
  constraints: z.string().optional(),
  checkout: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});

const startRunSchema = z
  .object({
    pipeline: z.string().describe("Filesystem path to a pipeline YAML file"),
    task_path: z.string().optional(),
    task: taskFileSchema.optional(),
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
      description: "List manifest-declared pipeline paths from the project catalog",
      inputSchema: z.object({}),
    },
    async () => {
      const catalog = await browseCatalog(cwd);
      return textResult({ pipelines: catalog.pipelines });
    },
  );

  server.registerTool(
    "list_tasks",
    {
      description: "List manifest-declared task paths from the project catalog",
      inputSchema: z.object({}),
    },
    async () => {
      const catalog = await browseCatalog(cwd);
      return textResult({ tasks: catalog.tasks });
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
        "Server health and soft-max run capacity: activeRunIds, activeCount, maxConcurrent, slotsAvailable. Start until slotsAvailable is 0; then wait for a run to finish or raise STAGEFLOW_MAX_CONCURRENT_RUNS.",
      inputSchema: z.object({}),
    },
    async () => textResult(manager.getHealth()),
  );

  server.registerTool(
    "start_run",
    {
      description:
        "Start a pipeline run using a filesystem pipeline path and either task_path (catalog task file) or an inline task object. Returns { runId }. On conflict returns isError with code busy_capacity (soft max full) or busy_checkout (same checkout leased), plus activeCount/maxConcurrent/activeRunIds and optional conflictingRunId/conflictingCheckout.",
      inputSchema: startRunSchema,
    },
    async ({ pipeline, task_path, task }) => {
      if (!pipeline.trim()) {
        return textResult({ error: "pipeline is required" }, true);
      }
      const taskInput = task_path ?? task;
      if (taskInput === undefined) {
        return textResult({ error: "Exactly one of task_path or task is required" }, true);
      }
      const result = await manager.startRun({ pipeline, task: taskInput });
      if (!result.ok) {
        const { ok: _ok, reason, ...rest } = result;
        return textResult({ error: reason, ...rest }, true);
      }
      return textResult({ runId: result.runId });
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
        const message = err instanceof Error ? err.message : String(err);
        const notFound = /not found|no such|unknown run/i.test(message);
        return textResult(
          {
            error: message,
            status: notFound ? 404 : 500,
          },
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
        const message = err instanceof Error ? err.message : String(err);
        const notFound =
          message.startsWith("Run not found") ||
          message.startsWith("Artifact not found") ||
          /no such|not found/i.test(message);
        return textResult(
          {
            error: message,
            status: notFound ? 404 : 400,
          },
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
        const result = await validateCatalog({
          cwd,
          scope,
          ...(scope === "pipeline" ? { pipeline: pipeline!.trim() } : {}),
          ...(scope === "task" ? { task: task!.trim() } : {}),
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
        const loaded = await loadPipeline(pipeline.trim(), { cwd });
        return textResult(describePipeline(loaded));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult({ error: message, status: 404 }, true);
      }
    },
  );
}

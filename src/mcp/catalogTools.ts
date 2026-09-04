import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { browseCatalog } from "../config/browseCatalog.js";
import { loadPipeline } from "../config/loadPipeline.js";
import { validateCatalog } from "../config/validateCatalog.js";
import type { ListRunsFilter, RunStatus } from "../runstore/port.js";
import type { McpToolDeps } from "./deps.js";
import { projectRunForMcp } from "./projectRun.js";
import { readRunArtifact } from "./readArtifact.js";
import { textResult } from "./toolResults.js";

const taskFileSchema = z.object({
  id: z.string(),
  goal: z.string(),
  context: z.string().optional(),
  constraints: z.string().optional(),
  checkout: z.string().optional(),
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
        "Read a text artifact from a run workspace by relative path (contained under the run workspace).",
      inputSchema: z.object({
        runId: z.string(),
        path: z.string(),
      }),
    },
    async ({ runId, path: artifactPath }) => {
      try {
        const content = await readRunArtifact(store, runId, artifactPath);
        return textResult({ runId, path: artifactPath, content });
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
        "Describe a pipeline DAG: stages with needs, fork, clonable, clone_cap, and gate_kinds. Input is a filesystem pipeline path (same as start_run).",
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
        const gateById = new Map(
          loaded.stages.map((s) => [s.id, s.gate_kinds] as const),
        );
        const stages = loaded.dag.nodes.map((node) => ({
          id: node.id,
          needs: node.needs,
          ...(node.fork !== undefined ? { fork: node.fork } : {}),
          ...(node.clonable !== undefined ? { clonable: node.clonable } : {}),
          ...(node.clone_cap !== undefined ? { clone_cap: node.clone_cap } : {}),
          ...(gateById.get(node.id) !== undefined
            ? { gate_kinds: gateById.get(node.id) }
            : {}),
        }));
        return textResult({
          id: loaded.pipeline.id,
          path: loaded.pipelinePath,
          stages,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult({ error: message, status: 404 }, true);
      }
    },
  );
}

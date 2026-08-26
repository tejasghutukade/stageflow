import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { listPipelines, listTasks } from "../config/listConfig.js";
import { resolveCatalogContext } from "../config/resolveCatalogContext.js";
import type { RunStore } from "../runstore/port.js";
import type { RunManager } from "../runtime/runManager.js";
import { projectRunForMcp } from "./projectRun.js";
import { readRunArtifact } from "./readArtifact.js";

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

function textResult(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export type McpToolDeps = {
  manager: RunManager;
  store: RunStore;
  cwd: string;
};

export function registerMcpTools(server: McpServer, deps: McpToolDeps): void {
  const { manager, store, cwd } = deps;

  server.registerTool(
    "list_pipelines",
    {
      description: "List manifest-declared pipeline paths from the project catalog",
      inputSchema: z.object({}),
    },
    async () => {
      const catalogCtx = await resolveCatalogContext(cwd);
      const pipelines =
        catalogCtx.manifestStatus === "ok" && catalogCtx.projectRoot && catalogCtx.manifest
          ? await listPipelines({
              projectRoot: catalogCtx.projectRoot,
              manifest: catalogCtx.manifest,
            })
          : [];
      return textResult({ pipelines });
    },
  );

  server.registerTool(
    "list_tasks",
    {
      description: "List manifest-declared task paths from the project catalog",
      inputSchema: z.object({}),
    },
    async () => {
      const catalogCtx = await resolveCatalogContext(cwd);
      const tasks =
        catalogCtx.manifestStatus === "ok" && catalogCtx.projectRoot && catalogCtx.manifest
          ? await listTasks({
              projectRoot: catalogCtx.projectRoot,
              manifest: catalogCtx.manifest,
            })
          : [];
      return textResult({ tasks });
    },
  );

  server.registerTool(
    "list_runs",
    {
      description: "List known pipeline runs",
      inputSchema: z.object({}),
    },
    async () => {
      const runs = await store.listRuns();
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
        "Poll a run: status, stage statuses, and envelope summary/payload/artifact paths (no events).",
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
}

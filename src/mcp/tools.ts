import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { listPipelines } from "../config/listConfig.js";
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
      description: "List runnable pipeline ids from the factory cwd",
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
        "Start a pipeline with an inline TaskFile (not written under tasks/). Returns { runId }. On conflict returns isError with code busy_capacity (soft max full) or busy_checkout (same checkout leased), plus activeCount/maxConcurrent/activeRunIds and optional conflictingRunId/conflictingCheckout.",
      inputSchema: z.object({
        pipeline: z.string(),
        task: taskFileSchema,
      }),
    },
    async ({ pipeline, task }) => {
      if (!pipeline.trim()) {
        return textResult({ error: "pipeline is required" }, true);
      }
      const result = await manager.startRun({ pipeline, task });
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

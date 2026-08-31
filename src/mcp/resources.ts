import {
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
} from "@modelcontextprotocol/server";
import { projectRunForMcp } from "./projectRun.js";
import type { McpToolDeps } from "./deps.js";

export const RUN_RESOURCE_URI_TEMPLATE = "stageflow://runs/{runId}";

export function runResourceUri(runId: string): string {
  return `stageflow://runs/${runId}`;
}

export function registerRunResources(
  server: McpServer,
  deps: McpToolDeps,
): void {
  const { store } = deps;

  server.registerResource(
    "run",
    new ResourceTemplate(RUN_RESOURCE_URI_TEMPLATE, {
      list: async () => {
        const runs = await store.listRuns();
        return {
          resources: runs.map((run) => ({
            uri: runResourceUri(run.run_id),
            name: run.run_id,
            mimeType: "application/json",
          })),
        };
      },
    }),
    {
      description:
        "Lean Stageflow run projection (same shape as get_run; no stage events)",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const runId = variables.runId;
      if (typeof runId !== "string" || runId.length === 0) {
        throw new ResourceNotFoundError(uri.href);
      }
      try {
        const detail = await store.readRun(runId);
        const projected = projectRunForMcp(detail);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(projected, null, 2),
            },
          ],
        };
      } catch {
        throw new ResourceNotFoundError(uri.href);
      }
    },
  );
}

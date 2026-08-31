import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerCatalogTools } from "./catalogTools.js";
import { registerControlTools } from "./controlTools.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";
import { DEFAULT_TIMEOUT_MS, waitRun } from "./waitRun.js";

export type { McpToolDeps };

export function registerMcpTools(server: McpServer, deps: McpToolDeps): void {
  const { store } = deps;

  registerCatalogTools(server, deps);
  registerControlTools(server, deps);

  server.registerTool(
    "wait_run",
    {
      description:
        "Long-poll until a run is waiting for HITL input and/or terminal (succeeded/failed), or until timeout_ms. Default until=any wakes on waiting OR terminal. Abort cancels only this wait (not the run). Optional notifications/progress when the client supplies _meta.progressToken. Compose: wait_run → answer_gate → wait_run.",
      inputSchema: z.object({
        runId: z.string(),
        timeout_ms: z
          .number()
          .optional()
          .describe(`Wait budget in ms (default ${DEFAULT_TIMEOUT_MS}, max 240000)`),
        until: z
          .enum(["any", "waiting", "terminal"])
          .optional()
          .describe('Wake predicate: "any" (default), "waiting", or "terminal"'),
      }),
    },
    async ({ runId, timeout_ms, until }, ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      const result = await waitRun({
        store,
        runId,
        timeoutMs: timeout_ms,
        until,
        signal: ctx.mcpReq.signal,
        onProgress:
          progressToken !== undefined
            ? async (info) => {
                try {
                  await ctx.mcpReq.notify({
                    method: "notifications/progress",
                    params: {
                      progressToken,
                      progress: info.progress,
                      message: info.message,
                    },
                  });
                } catch {
                }
              }
            : undefined,
      });
      if (!result.ok) {
        return textResult(
          {
            error: result.error,
            ...(result.status !== undefined ? { status: result.status } : {}),
            ...(result.code !== undefined ? { code: result.code } : {}),
          },
          true,
        );
      }
      return textResult({
        reason: result.reason,
        elapsed_ms: result.elapsed_ms,
        until: result.until,
        run: result.run,
      });
    },
  );
}

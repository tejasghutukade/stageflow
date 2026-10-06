import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  inspectProviderReadiness,
  mapProviderAuthError,
} from "../agent/providerInspect.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

export function registerProviderTools(
  server: McpServer,
  deps: McpToolDeps,
): void {
  server.registerTool(
    "list_providers",
    {
      description:
        "List login-capable model providers with auth readiness and a Pi-home detect summary. Read-only; does not log in or return secrets.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        return textResult(
          await inspectProviderReadiness(deps.cwd, deps.providerAuthContext),
        );
      } catch (err) {
        const mapped = mapProviderAuthError(err);
        return textResult(
          { error: mapped.body.error, status: mapped.status },
          true,
        );
      }
    },
  );
}

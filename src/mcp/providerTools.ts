import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  defaultContext,
  detectPiHome,
  getAuthStatus,
  listProviders,
  type ProviderAuthStatus,
} from "../agent/providerAuth.js";
import { providerAuthErrorBody } from "../server/providerRoutes.js";
import type { McpToolDeps } from "./deps.js";
import { textResult } from "./toolResults.js";

function statusList(
  statuses: ProviderAuthStatus | ProviderAuthStatus[],
): ProviderAuthStatus[] {
  return Array.isArray(statuses) ? statuses : [statuses];
}

export function registerProviderTools(
  server: McpServer,
  deps: McpToolDeps,
): void {
  const { cwd } = deps;
  const authCtx = deps.providerAuthContext ?? defaultContext;

  server.registerTool(
    "list_providers",
    {
      description:
        "List login-capable model providers with auth readiness and a Pi-home detect summary. Read-only; does not log in or return secrets.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const listed = await listProviders(cwd, authCtx);
        const statuses = statusList(
          await getAuthStatus(cwd, undefined, authCtx),
        );
        const statusById = new Map(
          statuses.map((status) => [status.providerId, status]),
        );
        const detect = detectPiHome(cwd);
        return textResult({
          authShell: listed.authShell,
          via: listed.via,
          detect,
          providers: listed.providers.map((provider) => {
            const status = statusById.get(provider.id);
            return {
              ...provider,
              configured: status?.configured ?? false,
              ...(status?.authKind !== undefined
                ? { authKind: status.authKind }
                : {}),
              ...(status?.source !== undefined ? { source: status.source } : {}),
            };
          }),
        });
      } catch (err) {
        const mapped = providerAuthErrorBody(err);
        return textResult(
          { error: mapped.body.error, status: mapped.status },
          true,
        );
      }
    },
  );
}

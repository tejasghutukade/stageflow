import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ResolvedMcpServers } from "../config/resolveStageMcpServers.js";

export const STAGEFLOW_PI_MCP_EXTENSION_NAME = "stageflow-mcp";

type CreateMcpAdapter = (options: {
  config: { mcpServers: ResolvedMcpServers };
}) => ExtensionFactory;

const PI_MCP_ADAPTER_SPEC: string = "pi-mcp-adapter";

async function loadCreateMcpAdapter(): Promise<CreateMcpAdapter> {
  try {
    const mod = (await import(PI_MCP_ADAPTER_SPEC)) as {
      createMcpAdapter: CreateMcpAdapter;
    };
    if (typeof mod.createMcpAdapter === "function") {
      return mod.createMcpAdapter;
    }
  } catch {
    // Node does not type-strip .ts under node_modules.
  }
  const { createJiti } = await import("jiti/static");
  const jiti = createJiti(import.meta.url);
  const mod = (await jiti.import(PI_MCP_ADAPTER_SPEC)) as {
    createMcpAdapter: CreateMcpAdapter;
  };
  return mod.createMcpAdapter;
}

const createMcpAdapter = await loadCreateMcpAdapter();

export function mcpExtensionFactoriesForSnapshot(
  snapshot?: ResolvedMcpServers,
): InlineExtension[] {
  if (snapshot === undefined || Object.keys(snapshot).length === 0) {
    return [];
  }
  return [
    {
      name: STAGEFLOW_PI_MCP_EXTENSION_NAME,
      factory: createMcpAdapter({
        config: { mcpServers: snapshot },
      }),
    },
  ];
}

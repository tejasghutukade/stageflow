import type { ExtensionFactory, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { ResolvedMcpServers } from "../config/resolveStageMcpServers.js";

export const STAGEFLOW_PI_MCP_EXTENSION_NAME = "stageflow-mcp";

export type IsolatedMcpSettings = {
  directTools: true;
  elicitation: false;
  hostConfigDiscovery: "off";
};

export type IsolatedMcpServerEntry = Record<string, unknown> & {
  lifecycle: "eager";
  directTools: true;
};

export type IsolatedMcpConfig = {
  mcpServers: Record<string, IsolatedMcpServerEntry>;
  settings: IsolatedMcpSettings;
};

const ISOLATED_MCP_SETTINGS: IsolatedMcpSettings = {
  directTools: true,
  elicitation: false,
  hostConfigDiscovery: "off",
};

export function toIsolatedMcpConfig(snapshot: ResolvedMcpServers): IsolatedMcpConfig {
  const mcpServers: Record<string, IsolatedMcpServerEntry> = {};
  for (const [name, entry] of Object.entries(snapshot)) {
    mcpServers[name] = {
      ...entry,
      lifecycle: "eager",
      directTools: true,
    };
  }
  return {
    mcpServers,
    settings: { ...ISOLATED_MCP_SETTINGS },
  };
}

type CreateMcpAdapter = (options: {
  config: IsolatedMcpConfig;
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
        config: toIsolatedMcpConfig(snapshot),
      }),
    },
  ];
}

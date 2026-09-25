import type { ProviderAuthContext } from "../agent/providerAuth.js";
import type { RunStore } from "../runstore/port.js";
import type { RunChangeBus } from "../runtime/runChangeBus.js";
import type { RunManager } from "../runtime/runManager.js";

export type McpToolDeps = {
  manager: RunManager;
  store: RunStore;
  cwd: string;
  agentDir?: string;
  providerAuthContext?: ProviderAuthContext;
  projectRoot?: string;
};

export type McpHttpDeps = McpToolDeps & {
  runChangeBus: RunChangeBus;
};

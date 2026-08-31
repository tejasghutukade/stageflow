import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { AgentPort } from "../agent/port.js";
import type { ProviderAuthContext } from "../agent/providerAuth.js";
import { createRunStore, type RunStoreKind } from "../runstore/createStore.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import { findProjectRoot } from "../project/findProjectRoot.js";
import type { RunStore } from "../runstore/port.js";
import { RunManager } from "../runtime/runManager.js";
import {
  createRunChangeBus,
  wrapRunStoreWithChangeBus,
  type RunChangeBus,
} from "../runtime/runChangeBus.js";
import {
  createMcpHttpHandler,
  resolveMcpStateless,
  type McpHttpHandler,
} from "../mcp/server.js";

export type StageflowHostOptions = {
  agent: AgentPort;
  cwd?: string;
  agentDir?: string;
  rootDir?: string;
  store?: RunStore;
  storeKind?: RunStoreKind;
  maxConcurrent?: number;
  providerAuthContext?: ProviderAuthContext;
  mcpStateless?: boolean;
  runChangeBus?: RunChangeBus;
};

export type StageflowHostBootstrap = {
  cwd: string;
  agentDir: string;
  rootDir: string;
  isGitProject: boolean;
  store: RunStore;
  manager: RunManager;
  runChangeBus: RunChangeBus;
  mcpStateless: boolean;
  providerAuthContext: ProviderAuthContext | undefined;
  mcpHandler: McpHttpHandler;
};

export async function bootstrapStageflowHost(
  options: StageflowHostOptions,
): Promise<StageflowHostBootstrap> {
  const invocationCwd = options.cwd ?? process.cwd();
  const ctx = await resolveStageflowContext(invocationCwd);
  const cwd = ctx.invocationCwd;
  const agentDir = options.agentDir ?? getAgentDir();
  const rootDir = options.rootDir ?? ctx.projectRoot;
  const isGitProject =
    options.rootDir !== undefined
      ? findProjectRoot(rootDir) !== null
      : ctx.isGitProject;
  const runChangeBus = options.runChangeBus ?? createRunChangeBus();
  const rawStore =
    options.store ??
    createRunStore({ rootDir, kind: options.storeKind });
  const store = wrapRunStoreWithChangeBus(rawStore, runChangeBus);
  const manager = new RunManager({
    agent: options.agent,
    cwd,
    projectRoot: rootDir,
    isGitProject,
    store,
    maxConcurrent: options.maxConcurrent,
    operatorCatalog: { cwd, agentDir },
  });
  await manager.attachWaitingStages();
  await manager.reconcileOrphanedStages();
  const mcpStateless = resolveMcpStateless({
    mcpStateless: options.mcpStateless,
  });
  const mcpHandler = createMcpHttpHandler(
    { manager, store, cwd, runChangeBus },
    { mcpStateless },
  );
  return {
    cwd,
    agentDir,
    rootDir,
    isGitProject,
    store,
    manager,
    runChangeBus,
    mcpStateless,
    providerAuthContext: options.providerAuthContext,
    mcpHandler,
  };
}

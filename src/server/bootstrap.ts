import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createA2aHost, type A2aHost } from "../a2a/server.js";
import type { AgentPort } from "../agent/port.js";
import type { ProviderAuthContext } from "../agent/providerAuth.js";
import type Database from "better-sqlite3";
import { createRunStoreWithConnection, type RunStoreKind } from "../runstore/createStore.js";
import { resolveA2aConfigPath } from "../a2a/configDiscovery.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import { findProjectRoot } from "../project/findProjectRoot.js";
import type { RunStore } from "../runstore/port.js";
import { RunManager } from "../runtime/runManager.js";
import {
  createRunChangeBus,
  getRunChangeBusFromWrappedStore,
  isRunStoreWrapped,
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
  a2a?: A2aHost;
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
  let rawStore: RunStore;
  let sqliteConnection: Database.Database | undefined;
  if (options.store) {
    rawStore = options.store;
  } else {
    const created = createRunStoreWithConnection({
      rootDir: ctx.globalHome,
      kind: options.storeKind,
      openerMode: "migrate",
    });
    rawStore = created.store;
    sqliteConnection = created.connection;
  }
  const boundBus = isRunStoreWrapped(rawStore)
    ? getRunChangeBusFromWrappedStore(rawStore)
    : undefined;
  if (
    boundBus !== undefined &&
    options.runChangeBus !== undefined &&
    options.runChangeBus !== boundBus
  ) {
    throw new Error(
      "runChangeBus does not match the bus already bound to the provided store",
    );
  }
  const runChangeBus =
    options.runChangeBus ?? boundBus ?? createRunChangeBus();
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
  await manager.resumeStalledSchedules();
  const mcpStateless = resolveMcpStateless({
    mcpStateless: options.mcpStateless,
  });
  const mcpHandler = createMcpHttpHandler(
    {
      manager,
      store,
      cwd,
      runChangeBus,
      providerAuthContext: options.providerAuthContext,
      projectRoot: rootDir,
    },
    { mcpStateless },
  );
  return {
    a2a: await createA2aHost(
      { manager, runStore: store, rootDir: ctx.globalHome, connection: sqliteConnection },
      resolveA2aConfigPath(rootDir),
    ),
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

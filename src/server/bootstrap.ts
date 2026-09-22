import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createA2aHost, type A2aHost } from "../a2a/server.js";
import { A2aStore } from "../a2a/store.js";
import type { AgentPort } from "../agent/port.js";
import type { ProviderAuthContext } from "../agent/providerAuth.js";
import type Database from "better-sqlite3";
import { createRunStoreWithConnection, type RunStoreKind } from "../runstore/createStore.js";
import { resolveA2aConfigPath } from "../a2a/configDiscovery.js";
import { ensureGlobalHome } from "../project/globalHome.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import { findProjectRoot } from "../project/findProjectRoot.js";
import type { RunStore } from "../runstore/port.js";
import { warnDurableRootDiskIfNeeded } from "../runstore/diskUsage.js";
import { RunManager } from "../runtime/runManager.js";
import { PI_CODING_AGENT_DIR_ENV } from "../runtime/stageRoots.js";
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

export const DEFAULT_GC_INTERVAL_MS = 60 * 60 * 1000;

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
  env?: NodeJS.ProcessEnv;
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
  /** Periodic retention GC handle when enabled; already `.unref()`'d. */
  gcInterval?: NodeJS.Timeout;
  stopGcInterval: () => void;
};

function sqliteConnectionFromStore(
  store: RunStore,
): Database.Database | undefined {
  const connection = (store as { connection?: unknown }).connection;
  if (
    connection !== undefined &&
    connection !== null &&
    typeof (connection as { prepare?: unknown }).prepare === "function"
  ) {
    return connection as Database.Database;
  }
  return undefined;
}

/** Parse `STAGEFLOW_GC_INTERVAL_MS`; default 1h; `0` disables. */
export function gcIntervalMsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env.STAGEFLOW_GC_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_GC_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_GC_INTERVAL_MS;
  return parsed;
}

/**
 * Start the unattended retention sweep. First fire is one interval after start
 * (`setInterval` semantics). Returns undefined when intervalMs is 0.
 */
export function startPeriodicRunGc(
  manager: RunManager,
  intervalMs: number,
  options?: {
    logError?: (message: string) => void;
  },
): NodeJS.Timeout | undefined {
  if (intervalMs <= 0) return undefined;
  const logError =
    options?.logError ??
    ((message: string) => {
      console.error(message);
    });
  let inFlight = false;
  return setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void manager
      .gcRuns({ execute: true, channel: "periodic" })
      .then((result) => {
        if (!result.ok) {
          logError(`periodic run GC failed: ${result.reason}`);
        }
      })
      .catch((err) => {
        logError(
          `periodic run GC failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      })
      .finally(() => {
        inFlight = false;
      });
  }, intervalMs).unref();
}

export async function bootstrapStageflowHost(
  options: StageflowHostOptions,
): Promise<StageflowHostBootstrap> {
  const env = options.env ?? process.env;
  const invocationCwd = options.cwd ?? process.cwd();
  const ctx = await resolveStageflowContext(invocationCwd);
  const cwd = ctx.invocationCwd;
  ensureGlobalHome();
  process.env[PI_CODING_AGENT_DIR_ENV] = path.join(ctx.globalHome, "agent");
  const agentDir = options.agentDir ?? getAgentDir();
  const rootDir = options.rootDir ?? ctx.projectRoot;
  const isGitProject =
    options.rootDir !== undefined
      ? findProjectRoot(rootDir) !== null
      : ctx.isGitProject;
  let rawStore: RunStore;
  let sqliteConnection: Database.Database | undefined;
  const storeRootDir = options.store
    ? (options.rootDir ?? ctx.globalHome)
    : ctx.globalHome;
  if (options.store) {
    rawStore = options.store;
    sqliteConnection = sqliteConnectionFromStore(rawStore);
  } else {
    const created = createRunStoreWithConnection({
      rootDir: ctx.globalHome,
      kind: options.storeKind,
      openerMode: "migrate",
    });
    rawStore = created.store;
    sqliteConnection = created.connection;
  }
  const a2aStore =
    sqliteConnection !== undefined
      ? new A2aStore(storeRootDir, sqliteConnection)
      : undefined;
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
    a2aStore,
  });
  await manager.attachWaitingStages();
  await manager.reconcileOrphanedStages();
  await manager.autoResumeInterruptedStages();
  await manager.resumeStalledSchedules();
  await manager.reenqueuePersistedQueuedRuns();
  await warnDurableRootDiskIfNeeded(ctx.globalHome, { env });
  const gcInterval = startPeriodicRunGc(manager, gcIntervalMsFromEnv(env));
  const stopGcInterval = () => {
    if (gcInterval !== undefined) clearInterval(gcInterval);
  };
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
      {
        manager,
        runStore: store,
        rootDir: storeRootDir,
        connection: sqliteConnection,
        a2aStore,
      },
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
    ...(gcInterval !== undefined ? { gcInterval } : {}),
    stopGcInterval,
  };
}

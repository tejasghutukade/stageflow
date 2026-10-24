import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createA2aHost, type A2aHost } from "../a2a/server.js";
import { A2aStore } from "../a2a/store.js";
import type { StagePort } from "../agent/port.js";
import type { ProviderAuthContext } from "../agent/providerAuth.js";
import type Database from "better-sqlite3";
import { createRunStoreWithConnection, sqliteConnectionFromStore, type RunStoreKind } from "../runstore/createStore.js";
import { resolveA2aConfigPath } from "../a2a/configDiscovery.js";
import { ensureProjectRootsFromEnv } from "../project/ensureProjectRootsFromEnv.js";
import { ensureGlobalHome, globalStageflowHome } from "../project/globalHome.js";
import {
  ensureWorkspaceCatalog,
  type WorkspaceProvisionResult,
} from "../project/workspaceCatalog.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import { findProjectRoot } from "../project/findProjectRoot.js";
import type { RunStore } from "../runstore/port.js";
import { warnDurableRootDiskIfNeeded } from "../runstore/diskUsage.js";
import { assertStoreFilesystemSupported } from "../runstore/storeFilesystem.js";
import type { StoreFilesystemClassification } from "../runstore/storeFilesystem.js";
import {
  assertStoreQuickCheck,
  isSqliteCorruptError,
  maybeCheckpointResidualWal,
  rethrowAsStoreIntegrityFailed,
} from "../runstore/sqlite/applyStorePragmas.js";
import type { StageBrowserSupport } from "../browser/browserHost.js";
import { consoleStageBrowserSupport } from "../browser/stageBrowserEnv.js";
import { RunManager } from "../runtime/runManager.js";
import { EvalRunManager } from "../evals/manager.js";
import { createStageCaseRunner } from "../evals/runner/stageCaseRunner.js";
import { getEngine } from "../evals/engine/index.js";
import { RunTokenRegistry } from "../evals/engine/promptfoo/runTokens.js";
import { EVAL_DEFAULT_ENGINE } from "../evals/manager.js";
import type { EvalInternalServices } from "./evalInternalRoutes.js";
import { PACKAGE_VERSION } from "../package-meta.js";
import { PI_CODING_AGENT_DIR_ENV } from "../runtime/stageRoots.js";
import {
  ScheduleSource,
  triggerTickIntervalMsFromEnv,
} from "../runtime/scheduleSource.js";
import {
  GithubPollSource,
  githubPollIntervalMsFromEnv,
} from "../runtime/githubPollSource.js";
import { EmailSource } from "../runtime/emailSource.js";
import { emailHostFor, releaseEmailHost } from "../email/host.js";
import { EmailTriggers } from "../email/triggers.js";
import { startChannelService, type ChannelService } from "../channels/service.js";
import { memoryHostFor, type MemoryHost } from "../memory/host.js";
import { fireTrigger } from "../runtime/triggerRunner.js";
import type { TriggerFireEvent } from "../runtime/triggerPort.js";
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
import {
  loadHostConfig,
  type HostConfig,
} from "../config/hostConfig.js";
import { bootProviderConfig } from "../agent/bootProviderConfig.js";
import { readCursorApiKey } from "../agent/cursorProvider.js";
import {
  applyPendingRestoreAtBoot,
  type BootRestoreOutcome,
} from "../runstore/restore.js";
import { assertTmpdirUsable } from "../runstore/assertTmpdir.js";
import { logger as rootLogger } from "../logging/logger.js";
import { getModelCatalog } from "../models/catalog.js";
import { createAgentCaseRunner } from "../evals/runner/agentCaseRunner.js";
import { createEvalCaseRunner } from "../evals/runner/caseRunner.js";
import { defaultLoadJudgePrices } from "../evals/engine/promptfoo/judgeServices.js";
import { createAgentHostContext, type AgentHostContext } from "../agents/hostContext.js";
import type { ConversationBackend } from "../agents/sessions.js";

export const DEFAULT_GC_INTERVAL_MS = 60 * 60 * 1000;

export type StageflowHostOptions = {
  agent: StagePort;
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
  hostConfig?: HostConfig;
  /** Skip HostConfig load (tests that inject store/manager pieces only). */
  skipHostConfig?: boolean;
  /** Browser support for the runs this Host executes; defaults to the local host with the live view relay. */
  browser?: StageBrowserSupport;
  emailTriggerQueue?: ConstructorParameters<typeof EmailTriggers>[0]["queue"];
  agentConversationBackend?: ConversationBackend;
};

export type StageflowHostBootstrap = {
  a2a?: A2aHost;
  cwd: string;
  agentDir: string;
  rootDir: string;
  isGitProject: boolean;
  /** Absent when `serveBlocked` — store must not be opened after a failed restore. */
  store?: RunStore;
  /** Absent when `serveBlocked` — no RunManager lifecycle/resume. */
  manager?: RunManager;
  /** Eval runs: shared with HTTP routes and MCP. Absent when `manager` is. */
  evalRunManager?: EvalRunManager;
  /** Services for the internal eval callback route; absent when `evalRunManager` is. */
  evalServices?: EvalInternalServices;
  /** Set once the HTTP host is listening so the promptfoo provider knows where to call back. */
  setEvalCallbackBase?: (baseUrl: string) => void;
  runChangeBus: RunChangeBus;
  mcpStateless: boolean;
  providerAuthContext: ProviderAuthContext | undefined;
  mcpHandler: McpHttpHandler;
  hostConfig?: HostConfig;
  providerBoot?: Awaited<ReturnType<typeof bootProviderConfig>>;
  /** Periodic retention GC handle when enabled; already `.unref()`'d. */
  gcInterval?: NodeJS.Timeout;
  stopGcInterval: () => void;
  workspaceCatalog?: WorkspaceProvisionResult;
  /** Stops the schedule-trigger tick loop started at boot. */
  stopScheduleSource: () => void;
  /** Stops the GitHub poll-trigger loop started at boot. */
  stopGithubPollSource: () => void;
  /** Stops the email-trigger IMAP/IDLE listeners started at boot. */
  stopEmailSource: () => void;
  /** Connections page read model and background health checks. */
  channels?: ChannelService;
  /** Named markdown pages under `$STAGEFLOW_HOME/memories`. */
  memories?: MemoryHost;
  /** Shared agent store, chat controller, and conversation backend for HTTP/MCP. */
  agentHost?: AgentHostContext;
  email?: ReturnType<typeof emailHostFor> & { triggers: EmailTriggers; stop: () => Promise<void> };
  /** Filesystem classification for `$STAGEFLOW_HOME` (Slot 8). */
  storeFilesystem?: StoreFilesystemClassification;
  /**
   * When set, Host must not serve API/MCP (restore.failed or failed boot apply).
   * /livez still answers; /readyz fails.
   */
  serveBlocked?: { code: string; reason: string };
};


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
  void globalStageflowHome();
  ensureGlobalHome();
  const cursorKey = readCursorApiKey(env);
  if (
    cursorKey !== undefined &&
    (env.CURSOR_API_KEY === undefined || env.CURSOR_API_KEY.trim() === "")
  ) {
    process.env.CURSOR_API_KEY = cursorKey;
  }
  assertTmpdirUsable(env);
  const hostConfig =
    options.hostConfig ??
    (options.skipHostConfig
      ? undefined
      : loadHostConfig({
          env,
          homeDir: ctx.globalHome,
          overrides:
            options.maxConcurrent !== undefined
              ? { maxConcurrentRuns: options.maxConcurrent }
              : undefined,
        }));
  for (const warning of hostConfig?.warnings ?? []) {
    console.warn(`stageflow: ${warning}`);
  }
  const providerBoot = options.skipHostConfig
    ? undefined
    : await bootProviderConfig({
        cwd: invocationCwd,
        env,
        requireProviders: hostConfig?.requireProviders,
        authContext: options.providerAuthContext,
      });
  process.env[PI_CODING_AGENT_DIR_ENV] = path.join(ctx.globalHome, "agent");
  const agentDir = options.agentDir ?? getAgentDir();
  const rootDir = options.rootDir ?? ctx.projectRoot;
  // Validate project account configuration before starting host resources.
  const emailHost = emailHostFor(rootDir);
  const isGitProject =
    options.rootDir !== undefined
      ? findProjectRoot(rootDir) !== null
      : ctx.isGitProject;

  const storeFilesystem = assertStoreFilesystemSupported(ctx.globalHome, {
    env,
    warn: (message) => console.warn(message),
  });

  const bootLog = rootLogger.child({ component: "bootstrap" });
  let serveBlocked: { code: string; reason: string } | undefined;
  let restoreOutcome: BootRestoreOutcome = { status: "none" };
  if (!options.store) {
    restoreOutcome = await applyPendingRestoreAtBoot(ctx.globalHome);
    if (restoreOutcome.status === "blocked") {
      serveBlocked = {
        code: "restore_failed",
        reason: restoreOutcome.reason,
      };
      bootLog.error(
        "restore.blocked",
        `restore.failed: ${restoreOutcome.reason}`,
      );
    } else if (restoreOutcome.status === "failed") {
      serveBlocked = {
        code: "restore_failed",
        reason: restoreOutcome.reason,
      };
      bootLog.error(
        "restore.apply_failed",
        `restore apply failed (attempts=${restoreOutcome.attempts}): ${restoreOutcome.reason}`,
      );
    } else if (restoreOutcome.status === "applied") {
      bootLog.info(
        "restore.applied",
        `restore applied schema_version=${restoreOutcome.result.schema_version}`,
      );
    }
  }

  if (serveBlocked !== undefined) {
    const runChangeBus = options.runChangeBus ?? createRunChangeBus();
    const mcpStateless = resolveMcpStateless({
      mcpStateless: options.mcpStateless,
    });
    return {
      cwd,
      agentDir,
      rootDir,
      isGitProject,
      runChangeBus,
      mcpStateless,
      providerAuthContext: options.providerAuthContext,
      mcpHandler: {
        handle: async () => {},
        close: async () => {},
      },
      stopGcInterval: () => {},
      stopScheduleSource: () => {},
      stopGithubPollSource: () => {},
      stopEmailSource: () => {},
      storeFilesystem,
      serveBlocked,
      ...(hostConfig !== undefined ? { hostConfig } : {}),
      ...(providerBoot !== undefined ? { providerBoot } : {}),
    };
  }

  let rawStore: RunStore;
  let sqliteConnection: Database.Database | undefined;
  const storeRootDir = options.store
    ? (options.rootDir ?? ctx.globalHome)
    : ctx.globalHome;
  if (options.store) {
    rawStore = options.store;
    sqliteConnection = sqliteConnectionFromStore(rawStore);
  } else {
    try {
      const created = createRunStoreWithConnection({
        rootDir: ctx.globalHome,
        kind: options.storeKind,
        openerMode: "migrate",
      });
      rawStore = created.store;
      sqliteConnection = created.connection;
    } catch (err) {
      if (isSqliteCorruptError(err)) {
        rethrowAsStoreIntegrityFailed(err);
      }
      throw err;
    }
  }

  if (sqliteConnection !== undefined) {
    try {
      assertStoreQuickCheck(sqliteConnection);
    } catch (err) {
      if (isSqliteCorruptError(err)) {
        rethrowAsStoreIntegrityFailed(err);
      }
      throw err;
    }
    maybeCheckpointResidualWal(storeRootDir, sqliteConnection, {
      log: (event, fields) => {
        bootLog.info(event, event, fields);
      },
    });
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
  await ensureProjectRootsFromEnv(env, store);
  const workspaceCatalog = ensureWorkspaceCatalog(ctx.globalHome);
  if (!workspaceCatalog.ok) {
    bootLog.warn(
      "workspace.provision_failed",
      workspaceCatalog.reason ?? "unknown",
    );
  }
  const manager = new RunManager({
    agent: options.agent,
    cwd,
    projectRoot: rootDir,
    isGitProject,
    store,
    maxConcurrent:
      options.maxConcurrent ??
      (hostConfig?.maxConcurrentRunsExplicit
        ? hostConfig.maxConcurrentRuns
        : undefined),
    maxQueued: hostConfig?.maxQueued,
    maxConcurrentPerProject: hostConfig?.maxConcurrentRunsPerProject,
    callerQuotas: Object.fromEntries(
      Object.entries(hostConfig?.callers ?? {}).map(([id, cfg]) => [
        id,
        cfg.maxConcurrent,
      ]),
    ),
    operatorCatalog: { cwd, agentDir },
    a2aStore,
    browser: options.browser ?? consoleStageBrowserSupport(),
  });
  await manager.attachWaitingStages();
  await manager.reconcileOrphanedStages();
  await manager.sweepBrowserSessions().catch(() => undefined);
  await manager.autoResumeInterruptedStages();
  await manager.resumeStalledSchedules();
  await manager.reenqueuePersistedQueuedRuns();
  const evalLog = rootLogger.child({ component: "evals" });
  const evalStageRunner = createStageCaseRunner({ manager, store });
  const evalAgentRunner = createAgentCaseRunner({
    host: () => agentHost,
    loadPrices: defaultLoadJudgePrices,
  });
  const evalRunner = createEvalCaseRunner({ stage: evalStageRunner, agent: evalAgentRunner });
  const evalTokens = new RunTokenRegistry();
  let evalCallbackBase = "";
  const evalRunManager = new EvalRunManager({
    store,
    stageRunner: evalRunner,
    agents: () => agentHost?.service,
    engines: (name, engineOptions) =>
      getEngine(
        name,
        name === EVAL_DEFAULT_ENGINE
          ? {
              tokens: evalTokens,
              callbackUrl: () => `${evalCallbackBase}/api/evals/internal/run-case`,
              home: ctx.globalHome,
              ...(engineOptions as Record<string, unknown> | undefined),
            }
          : engineOptions,
      ),
    stageflowVersion: PACKAGE_VERSION,
    workDirRoot: path.join(ctx.globalHome, "eval-runs"),
    logger: {
      info: (event, msg) => evalLog.info(event, msg),
      warn: (event, msg) => evalLog.warn(event, msg),
      error: (event, msg) => evalLog.error(event, msg),
    },
  });
  const recoveredEvalRuns = await evalRunManager.recoverOnBoot().catch((err: unknown): string[] => {
    evalLog.warn("eval.recover_failed", err instanceof Error ? err.message : String(err));
    return [];
  });
  const evalServices: EvalInternalServices = {
    tokens: evalTokens,
    runner: evalRunner,
    isRunning: (evalRunId) => evalRunManager.isExecuting(evalRunId),
  };
  const setEvalCallbackBase = (baseUrl: string): void => {
    evalCallbackBase = baseUrl.replace(/\/+$/, "");
  };
  await warnDurableRootDiskIfNeeded(ctx.globalHome, { env });
  const gcInterval = startPeriodicRunGc(manager, gcIntervalMsFromEnv(env));
  const stopGcInterval = () => {
    if (gcInterval !== undefined) clearInterval(gcInterval);
  };

  const scheduleSource = new ScheduleSource({
    store,
    cwd,
    intervalMs: triggerTickIntervalMsFromEnv(env),
    logError: (message) => bootLog.error("trigger.schedule_source_failed", message),
  });
  const onTriggerFire = async (event: TriggerFireEvent) => {
    try {
      const result = await fireTrigger(event.triggerId, store, manager, {
        cwd,
        task: event.task,
        ...(event.project_root !== undefined
          ? { project_root: event.project_root }
          : {}),
      });
      if (!result.ok) {
        bootLog.error(
          "trigger.fire_failed",
          `trigger "${event.triggerId}" fire failed: ${result.reason}`,
        );
      }
    } catch (err) {
      bootLog.error(
        "trigger.fire_failed",
        `trigger "${event.triggerId}" fire threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
  try {
    // Boot-time catch-up: fire once for any schedule trigger whose next_run_at
    // already passed while the Host was down, then reschedule from now —
    // before starting the periodic ticker so this pass never races it.
    await scheduleSource.tick(onTriggerFire);
  } catch (err) {
    bootLog.error(
      "trigger.schedule_catchup_failed",
      `boot catch-up tick failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await scheduleSource.start(onTriggerFire);
  const stopScheduleSource = () => {
    void scheduleSource.stop();
  };

  const githubPollSource = new GithubPollSource({
    store,
    cwd,
    intervalMs: githubPollIntervalMsFromEnv(env),
    logError: (message) => bootLog.error("trigger.github_poll_source_failed", message),
  });
  await githubPollSource.start(onTriggerFire);
  const stopGithubPollSource = () => {
    void githubPollSource.stop();
  };

  const emailSource = new EmailSource({
    store,
    cwd,
    logError: (message) => bootLog.error("trigger.email_source_failed", message),
  });
  await emailSource.start(onTriggerFire);
  const emailTriggers = new EmailTriggers({ cwd: rootDir, accounts: emailHost.accounts, mailbox: emailHost.mailbox, manager, store, queue: options.emailTriggerQueue });
  let stoppingEmail: Promise<void> | undefined;
  const stopAccountEmail = (): Promise<void> => stoppingEmail ??= Promise.all([emailTriggers.stop(), releaseEmailHost(rootDir)]).then(() => undefined);
  void emailTriggers.recover().catch(() => undefined);
  try {
    await emailHost.mailbox.start(event => emailTriggers.accept(event));
  } catch (error) {
    await Promise.all([stopAccountEmail(), emailSource.stop(), scheduleSource.stop(), githubPollSource.stop()]);
    throw error;
  }
  const channels = startChannelService(cwd);
  const stopEmailSource = () => {
    void agentHost?.stop();
    void emailSource.stop();
    void stopAccountEmail();
    void channels.stop();
  };

  // Resolve the connected-provider list and the default model once at boot so sync callers see the catalog's answer.
  void getModelCatalog(cwd)
    .defaultModel()
    .catch((error) => bootLog.warn("models.catalog_warm_failed", String(error)));
  const agentHost =
    sqliteConnection !== undefined
      ? createAgentHostContext({
          cwd,
          agentDir,
          connection: sqliteConnection,
          channels,
          ...(options.agentConversationBackend ? { backend: options.agentConversationBackend } : {}),
          listenOnChannels: process.env.STAGEFLOW_AGENT_CHANNEL_LISTENERS !== "0",
          toolkitDeps: {
            manager,
            store,
            agentDir,
            projectRoot: rootDir,
            ...(options.providerAuthContext ? { providerAuthContext: options.providerAuthContext } : {}),
            ...(providerBoot !== undefined ? { providerBoot } : {}),
          },
        })
      : undefined;
  if (agentHost) void evalRunManager.sweepAgentSessions(recoveredEvalRuns);
  const mcpStateless = resolveMcpStateless({
    mcpStateless: options.mcpStateless,
  });
  const mcpHandler = createMcpHttpHandler(
    {
      manager,
      store,
      cwd,
      agentDir,
      runChangeBus,
      providerAuthContext: options.providerAuthContext,
      projectRoot: rootDir,
      evalRunManager,
      ...(agentHost
        ? {
            agentService: agentHost.service,
            agentChat: agentHost.chat,
            agentConversationBackend: agentHost.backend,
          }
        : {}),
      ...(providerBoot !== undefined ? { providerBoot } : {}),
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
    evalRunManager,
    evalServices,
    setEvalCallbackBase,
    runChangeBus,
    mcpStateless,
    providerAuthContext: options.providerAuthContext,
    mcpHandler,
    ...(hostConfig !== undefined ? { hostConfig } : {}),
    ...(providerBoot !== undefined ? { providerBoot } : {}),
    ...(gcInterval !== undefined ? { gcInterval } : {}),
    stopGcInterval,
    stopScheduleSource,
    stopGithubPollSource,
    stopEmailSource,
    email: { ...emailHost, triggers: emailTriggers, stop: stopAccountEmail },
    channels,
    memories: memoryHostFor(),
    storeFilesystem,
    workspaceCatalog,
    ...(agentHost ? { agentHost } : {}),
  };
}

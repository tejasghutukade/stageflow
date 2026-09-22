import type { Server } from "node:http";
import {
  logger as rootLogger,
  type Logger,
} from "../logging/logger.js";
import type { RunStore } from "../runstore/port.js";
import type { RunManager } from "../runtime/runManager.js";

export const SHUTDOWN_GRACE_MS_ENV = "STAGEFLOW_SHUTDOWN_GRACE_MS";
export const DEFAULT_SHUTDOWN_GRACE_MS = 8000;
export const CHECKPOINT_RESERVE_MS = 2000;
export const ESCALATION_CHECKPOINT_MS = 1000;

export const HOST_EXIT = {
  CLEAN: 0,
  CRASH: 1,
  RESERVED: 2,
  BAD_CONFIG: 3,
  STORE_NEWER: 4,
  FORCED: 5,
  ESCALATED: 6,
} as const;

export type HostExitCode =
  (typeof HOST_EXIT)[keyof typeof HOST_EXIT];

export type HostDrainResult = {
  exitCode: typeof HOST_EXIT.CLEAN | typeof HOST_EXIT.FORCED | typeof HOST_EXIT.ESCALATED;
  forced: boolean;
  escalated: boolean;
};

export type ShutdownControllerOptions = {
  server: Server;
  manager: RunManager;
  store: RunStore;
  graceMs?: number;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  /** When false, callers drive drain via `beginDrain()` (tests). Default true. */
  installSignals?: boolean;
};

export function parseShutdownGraceMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[SHUTDOWN_GRACE_MS_ENV]?.trim();
  if (raw === undefined || raw === "") {
    return DEFAULT_SHUTDOWN_GRACE_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_SHUTDOWN_GRACE_MS;
  }
  return Math.floor(parsed);
}

export function workerBudgetMs(graceMs: number): number {
  return Math.max(0, graceMs - CHECKPOINT_RESERVE_MS);
}

export class ShutdownController {
  private readonly server: Server;
  private readonly manager: RunManager;
  private readonly store: RunStore;
  private readonly graceMs: number;
  private readonly log: Logger;
  private readonly installSignals: boolean;
  private drainPromise: Promise<HostDrainResult> | undefined;
  private escalated = false;
  private readonly escalateWaiters = new Set<() => void>();
  private installed = false;
  private drainStarted:
    | { resolve: (result: Promise<HostDrainResult>) => void; promise: Promise<Promise<HostDrainResult>> }
    | undefined;

  constructor(options: ShutdownControllerOptions) {
    this.server = options.server;
    this.manager = options.manager;
    this.store = options.store;
    this.graceMs =
      options.graceMs ?? parseShutdownGraceMs(options.env ?? process.env);
    this.log =
      options.logger ?? rootLogger.child({ component: "shutdown" });
    this.installSignals = options.installSignals !== false;
  }

  install(): void {
    if (!this.installSignals || this.installed) return;
    this.installed = true;
    process.on("SIGTERM", this.onSignal);
    process.on("SIGINT", this.onSignal);
  }

  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    process.off("SIGTERM", this.onSignal);
    process.off("SIGINT", this.onSignal);
  }

  /** Deliver a SIGTERM/SIGINT-equivalent (tests and supervisors). */
  notifySignal(): void {
    this.onSignal();
  }

  whenDrained(): Promise<HostDrainResult> {
    if (this.drainPromise !== undefined) {
      return this.drainPromise;
    }
    if (this.drainStarted === undefined) {
      let resolve!: (result: Promise<HostDrainResult>) => void;
      const promise = new Promise<Promise<HostDrainResult>>((r) => {
        resolve = r;
      });
      this.drainStarted = { resolve, promise };
    }
    return this.drainStarted.promise.then((p) => p);
  }

  beginDrain(): Promise<HostDrainResult> {
    if (this.drainPromise !== undefined) {
      return this.drainPromise;
    }
    this.drainPromise = this.runDrain();
    if (this.drainStarted === undefined) {
      let resolve!: (result: Promise<HostDrainResult>) => void;
      const promise = new Promise<Promise<HostDrainResult>>((r) => {
        resolve = r;
      });
      this.drainStarted = { resolve, promise };
    }
    this.drainStarted.resolve(this.drainPromise);
    return this.drainPromise;
  }

  private readonly onSignal = (): void => {
    if (this.drainPromise === undefined) {
      this.log.info("host.shutdown.signal", "shutdown signal received", {
        grace_ms: this.graceMs,
      });
      void this.beginDrain();
      return;
    }
    if (this.escalated) return;
    this.escalated = true;
    this.log.warn(
      "host.shutdown.escalated",
      "second shutdown signal; escalating",
      { grace_ms: this.graceMs },
    );
    for (const wake of this.escalateWaiters) {
      wake();
    }
    this.escalateWaiters.clear();
  };

  private waitUntil(deadlineMs: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearInterval(timer);
        this.escalateWaiters.delete(finish);
        resolve();
      };
      const timer = setInterval(() => {
        if (this.escalated || Date.now() >= deadlineMs) {
          finish();
        }
      }, 25);
      this.escalateWaiters.add(finish);
      if (this.escalated || Date.now() >= deadlineMs) {
        finish();
      }
    });
  }

  private async runDrain(): Promise<HostDrainResult> {
    const startedAt = Date.now();
    const hardDeadline = startedAt + this.graceMs;
    const workerDeadline = startedAt + workerBudgetMs(this.graceMs);

    this.log.info("host.shutdown.drain_start", "beginning host drain", {
      grace_ms: this.graceMs,
      worker_budget_ms: workerBudgetMs(this.graceMs),
    });

    this.manager.stopAcceptingWork();

    try {
      this.server.closeIdleConnections();
    } catch {
      // older Node or already closing
    }

    const serverClosed = new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });

    const stageResult = await this.manager.drainActiveStages({
      deadlineMs: workerDeadline,
      isEscalated: () => this.escalated,
    });

    const checkpointDeadline = this.escalated
      ? Date.now() + ESCALATION_CHECKPOINT_MS
      : hardDeadline;

    let storeCloseFailed = false;
    try {
      await this.store.close();
    } catch (err) {
      storeCloseFailed = true;
      this.log.error(
        "host.shutdown.store_close_failed",
        err instanceof Error ? err.message : String(err),
      );
    }

    await Promise.race([
      serverClosed,
      this.waitUntil(checkpointDeadline),
    ]);

    try {
      this.server.closeAllConnections();
    } catch {
      // ignore
    }

    await Promise.race([
      serverClosed,
      this.waitUntil(Date.now() + 100),
    ]);

    this.uninstall();

    const forced = stageResult.forced || storeCloseFailed;
    const exitCode = this.escalated
      ? HOST_EXIT.ESCALATED
      : forced
        ? HOST_EXIT.FORCED
        : HOST_EXIT.CLEAN;

    this.log.info("host.shutdown.drain_complete", "host drain complete", {
      exit_code: exitCode,
      forced,
      escalated: this.escalated,
      elapsed_ms: Date.now() - startedAt,
    });

    return {
      exitCode,
      forced,
      escalated: this.escalated,
    };
  }
}

export function installShutdownController(
  options: ShutdownControllerOptions,
): ShutdownController {
  const controller = new ShutdownController(options);
  controller.install();
  return controller;
}

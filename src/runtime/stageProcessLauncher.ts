import { fork, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  logger as rootLogger,
  resolveLogMaxLineBytes,
  type Logger,
} from "../logging/logger.js";
import {
  readMaxActiveStageProcesses,
} from "./stageConcurrency.js";
import {
  SF_STAGE_WORKER,
  STAGE_WORKER_EXIT,
  type StageWorkerResult,
} from "./stageWorkerProtocol.js";
import type { OperatorCatalog } from "./stageAttemptBootstrap.js";
import {
  overlayStageBindingEnv,
  type DerivedBindingKind,
} from "./stageRoots.js";

export type StageLaunchInput = {
  runId: string;
  stageId: string;
  rootDir: string;
  mode?: "run" | "resume" | "feedback_resume" | "new_session";
  resumeAnswer?: unknown;
  attempt?: number;
  sessionFilePath?: string;
  operatorCatalog?: OperatorCatalog;
  skipGates?: boolean;
  env?: Record<string, string>;
  bindingKind?: DerivedBindingKind;
};

export type StageLaunchResult =
  | { type: "succeeded" }
  | { type: "failed"; reason: string }
  | { type: "waiting" };

export type ActiveStageProcess = {
  runId: string;
  stageId: string;
  startedAt: number;
};

type TrackedChild = ActiveStageProcess & {
  child: ChildProcess;
};

export type StageProcessLauncherOptions = {
  maxActiveStageProcesses?: number;
  env?: Record<string, string | undefined>;
  cliEntry?: string;
  logger?: Logger;
};

function flushCappedPartial(
  log: Logger,
  event: "stage.stdout" | "stage.stderr",
  text: string,
  maxLineBytes: number,
): string {
  let remaining = text;
  while (Buffer.byteLength(remaining, "utf8") > maxLineBytes) {
    const bytes = Buffer.from(remaining, "utf8");
    const originalBytes = bytes.byteLength;
    const piece = bytes.subarray(0, maxLineBytes).toString("utf8");
    log.info(event, piece, {
      truncated: true,
      original_bytes: originalBytes,
    });
    remaining = bytes.subarray(maxLineBytes).toString("utf8");
  }
  return remaining;
}

function attachStreamLineLogger(
  stream: Readable | null,
  log: Logger,
  event: "stage.stdout" | "stage.stderr",
  maxLineBytes: number,
): void {
  if (!stream) return;
  let buffer = "";
  stream.on("data", (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      log.info(event, line);
    }
    buffer = flushCappedPartial(log, event, buffer, maxLineBytes);
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      buffer = flushCappedPartial(log, event, buffer, maxLineBytes);
      if (buffer.length > 0) {
        log.info(event, buffer);
      }
      buffer = "";
    }
  });
}

function activeKey(runId: string, stageId: string): string {
  return `${runId}\0${stageId}`;
}

function isStageWorkerResult(value: unknown): value is StageWorkerResult {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: string }).type;
  return type === "succeeded" || type === "failed" || type === "waiting";
}

function resultFromExitCode(code: number | null): StageLaunchResult {
  if (code === STAGE_WORKER_EXIT.SUCCEEDED) {
    return { type: "succeeded" };
  }
  if (code === STAGE_WORKER_EXIT.WAITING) {
    return { type: "waiting" };
  }
  if (code === STAGE_WORKER_EXIT.FAILED) {
    return { type: "failed", reason: "stage failed" };
  }
  return {
    type: "failed",
    reason: code === null ? "stage process exited" : `stage process exit ${code}`,
  };
}

function resultFromWorkerMessage(msg: StageWorkerResult): StageLaunchResult {
  if (msg.type === "succeeded") {
    return { type: "succeeded" };
  }
  if (msg.type === "waiting") {
    return { type: "waiting" };
  }
  return { type: "failed", reason: msg.reason };
}

export function signalProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
      return;
    }
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  }
}

export class StageProcessLauncher {
  private readonly maxActive: number;
  private readonly env: Record<string, string | undefined>;
  private readonly cliEntry: string;
  private readonly logger: Logger;
  private readonly active = new Map<string, TrackedChild>();
  private readonly waitQueue: Array<() => void> = [];
  private slotsHeld = 0;

  constructor(options: StageProcessLauncherOptions = {}) {
    this.env = options.env ?? process.env;
    this.maxActive = readMaxActiveStageProcesses(
      this.env,
      options.maxActiveStageProcesses,
    );
    this.cliEntry =
      options.cliEntry ??
      fileURLToPath(new URL("../cli.js", import.meta.url));
    this.logger =
      options.logger ?? rootLogger.child({ component: "runtime" });
  }

  activeCount(): number {
    return this.active.size;
  }

  getActiveStageProcesses(): ActiveStageProcess[] {
    return [...this.active.values()].map(({ runId, stageId, startedAt }) => ({
      runId,
      stageId,
      startedAt,
    }));
  }

  signalAllActive(signal: NodeJS.Signals): void {
    for (const entry of this.active.values()) {
      signalProcessGroup(entry.child.pid, signal);
    }
  }

  async launch(input: StageLaunchInput): Promise<StageLaunchResult> {
    await this.waitForCapacity();
    return this.spawnAndWait(input);
  }

  async cancelRun(runId: string, killAfterMs = 5000): Promise<void> {
    const children = [...this.active.values()].filter(
      (entry) => entry.runId === runId,
    );
    if (children.length === 0) {
      return;
    }

    await Promise.all(
      children.map(
        (entry) =>
          new Promise<void>((resolve) => {
            const child = entry.child;
            const pid = child.pid;
            let settled = false;
            let exited = false;
            let escalateTimer: NodeJS.Timeout | undefined;
            const finish = () => {
              if (settled) return;
              settled = true;
              if (escalateTimer !== undefined) clearTimeout(escalateTimer);
              resolve();
            };
            child.once("exit", () => {
              exited = true;
              // Parent may exit on SIGTERM while SIGTERM-proof grandchildren remain.
              signalProcessGroup(pid, "SIGKILL");
              finish();
            });
            signalProcessGroup(pid, "SIGTERM");
            if (killAfterMs > 0) {
              escalateTimer = setTimeout(() => {
                if (!exited) {
                  signalProcessGroup(pid, "SIGKILL");
                }
              }, killAfterMs);
            }
          }),
      ),
    );
  }

  private async waitForCapacity(): Promise<void> {
    if (!Number.isFinite(this.maxActive)) {
      return;
    }
    if (this.slotsHeld < this.maxActive) {
      this.slotsHeld += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
    return this.waitForCapacity();
  }

  private releaseCapacity(): void {
    if (!Number.isFinite(this.maxActive)) {
      return;
    }
    this.slotsHeld -= 1;
    if (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift();
      next?.();
    }
  }

  private spawnAndWait(input: StageLaunchInput): Promise<StageLaunchResult> {
    const mode =
      input.mode ?? (input.resumeAnswer !== undefined ? "resume" : "run");
    const args = [
      "internal",
      "run-stage",
      "--run-id",
      input.runId,
      "--stage-id",
      input.stageId,
      "--mode",
      mode,
    ];
    if (input.resumeAnswer !== undefined) {
      args.push("--resume-answer", JSON.stringify(input.resumeAnswer));
    }
    if (input.attempt !== undefined) {
      args.push("--attempt", String(input.attempt));
    }
    if (input.sessionFilePath !== undefined) {
      args.push("--session-file", input.sessionFilePath);
    }
    if (input.operatorCatalog?.cwd !== undefined) {
      args.push("--operator-cwd", input.operatorCatalog.cwd);
    }
    if (input.operatorCatalog?.agentDir !== undefined) {
      args.push("--operator-agent-dir", input.operatorCatalog.agentDir);
    }
    if (input.skipGates) {
      args.push("--skip-gates");
    }

    const childEnv =
      input.env !== undefined
        ? overlayStageBindingEnv(
            { ...process.env, ...this.env },
            input.env,
            input.bindingKind ?? "unbound",
          )
        : { ...process.env, ...this.env };

    const child = fork(this.cliEntry, args, {
      cwd: input.rootDir,
      env: { ...childEnv, [SF_STAGE_WORKER]: "1" },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      detached: true,
    });

    const key = activeKey(input.runId, input.stageId);
    const tracked: TrackedChild = {
      child,
      runId: input.runId,
      stageId: input.stageId,
      startedAt: Date.now(),
    };
    this.active.set(key, tracked);

    const stageLog = this.logger.child({
      run_id: input.runId,
      stage_id: input.stageId,
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    });
    const maxLineBytes = resolveLogMaxLineBytes(this.env);
    attachStreamLineLogger(child.stdout, stageLog, "stage.stdout", maxLineBytes);
    attachStreamLineLogger(child.stderr, stageLog, "stage.stderr", maxLineBytes);

    return new Promise<StageLaunchResult>((resolve) => {
      let settled = false;

      const cleanup = () => {
        this.active.delete(key);
        this.releaseCapacity();
      };

      const finish = (result: StageLaunchResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };

      child.on("message", (message: unknown) => {
        if (!isStageWorkerResult(message)) return;
        finish(resultFromWorkerMessage(message));
      });

      child.on("exit", (code) => {
        if (settled) return;
        finish(resultFromExitCode(code));
      });

      child.on("error", (err) => {
        finish({
          type: "failed",
          reason: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }
}

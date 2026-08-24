import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  readMaxActiveStageProcesses,
} from "./stageConcurrency.js";
import {
  SF_STAGE_WORKER,
  STAGE_WORKER_EXIT,
  type StageWorkerResult,
} from "./stageWorkerProtocol.js";
import type { OperatorCatalog } from "./stageAttemptBootstrap.js";

export type StageLaunchInput = {
  runId: string;
  stageId: string;
  rootDir: string;
  mode?: "run" | "resume";
  resumeAnswer?: unknown;
  attempt?: number;
  sessionFilePath?: string;
  operatorCatalog?: OperatorCatalog;
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
};

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

export class StageProcessLauncher {
  private readonly maxActive: number;
  private readonly env: Record<string, string | undefined>;
  private readonly cliEntry: string;
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
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              resolve();
            };
            child.once("exit", finish);
            child.kill("SIGTERM");
            if (killAfterMs > 0) {
              setTimeout(() => {
                if (!child.killed) {
                  child.kill("SIGKILL");
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
    if (input.operatorCatalog?.agentDir !== undefined) {
      args.push("--operator-agent-dir", input.operatorCatalog.agentDir);
    }

    const child = fork(this.cliEntry, args, {
      cwd: input.rootDir,
      env: { ...process.env, ...this.env, [SF_STAGE_WORKER]: "1" },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    const key = activeKey(input.runId, input.stageId);
    const tracked: TrackedChild = {
      child,
      runId: input.runId,
      stageId: input.stageId,
      startedAt: Date.now(),
    };
    this.active.set(key, tracked);

    if (child.stderr) {
      let stderrBuffer = "";
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrBuffer += chunk.toString();
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) {
          process.stderr.write(`[stage:${input.stageId}] ${line}\n`);
        }
      });
      child.stderr.on("end", () => {
        if (stderrBuffer.length > 0) {
          process.stderr.write(`[stage:${input.stageId}] ${stderrBuffer}\n`);
          stderrBuffer = "";
        }
      });
    }

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

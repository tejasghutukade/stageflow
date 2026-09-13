import { fork, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  mode?: "run" | "resume" | "feedback_resume" | "new_session";
  resumeAnswer?: unknown;
  attempt?: number;
  sessionFilePath?: string;
  operatorCatalog?: OperatorCatalog;
  skipGates?: boolean;
};

/**
 * Opt-in env var: when set to a non-empty image reference, stage attempts
 * run inside `docker run --rm` instead of a forked Node worker. Unset (the
 * default) preserves today's fork-based execution exactly.
 */
export const STAGE_CONTAINER_IMAGE_ENV = "STAGEFLOW_STAGE_CONTAINER_IMAGE";
export const STAGE_CONTAINER_DOCKER_BIN_ENV =
  "STAGEFLOW_STAGE_CONTAINER_DOCKER_BIN";

/**
 * Credential env vars forwarded into the container by default, bare-name
 * (`-e NAME`) so values never appear in argv/`ps` output on the host.
 * Deliberately narrow (host-process mode still gets the full environment
 * unchanged) — a stage needing another var (a proxy setting, a different
 * provider's token, NODE_OPTIONS, a CA bundle) must pass its own
 * `StageContainerOptions.forwardEnvVars` covering everything it needs,
 * since it replaces rather than extends this default list.
 */
export const DEFAULT_STAGE_CONTAINER_FORWARD_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
];

export type StageContainerCacheMount = {
  /** Host-side subdirectory name for this mount, e.g. "node_modules". */
  label: string;
  /** Absolute path inside the container to mount the cache at. */
  containerPath: string;
};

export type StageContainerOptions = {
  image: string;
  dockerBin?: string;
  forwardEnvVars?: string[];
  /** Host directory under which per-run/per-stage cache subdirectories live. */
  cacheRoot?: string;
  cacheMounts?: StageContainerCacheMount[];
};

/**
 * Cache mounts are scoped by run id + stage id, never shared across them:
 * concurrent fan-out clones (distinct stage ids, e.g. "review~1"/"review~2")
 * get distinct host paths, so they can never clobber each other's cache
 * writes. Retries of the *same* stage id reuse the same path on purpose.
 */
export function buildCacheMountArgs(params: {
  runId: string;
  stageId: string;
  cacheRoot: string;
  cacheMounts: StageContainerCacheMount[];
}): string[] {
  const { runId, stageId, cacheRoot, cacheMounts } = params;
  const scopeDir = `${cacheRoot}/${sanitizeContainerNameSegment(runId)}/${sanitizeContainerNameSegment(stageId)}`;
  const args: string[] = [];
  for (const mount of cacheMounts) {
    args.push(
      "-v",
      `${scopeDir}/${sanitizeContainerNameSegment(mount.label)}:${mount.containerPath}`,
    );
  }
  return args;
}

function resolveContainerOptions(
  env: Record<string, string | undefined>,
  override?: StageContainerOptions,
): StageContainerOptions | undefined {
  if (override) {
    if (!override.image || override.image.trim() === "") {
      throw new Error(
        "StageProcessLauncher: container.image must be a non-empty string",
      );
    }
    return { ...override, dockerBin: override.dockerBin || "docker" };
  }
  const image = env[STAGE_CONTAINER_IMAGE_ENV];
  if (!image || image.trim() === "") return undefined;
  return {
    image,
    dockerBin: env[STAGE_CONTAINER_DOCKER_BIN_ENV] || "docker",
  };
}

/** Docker container names allow only `[a-zA-Z0-9_.-]`. */
export function sanitizeContainerNameSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

export function buildContainerName(
  input: { runId: string; stageId: string; attempt?: number },
  suffix: string,
): string {
  const runId = sanitizeContainerNameSegment(input.runId);
  const stageId = sanitizeContainerNameSegment(input.stageId);
  const attempt = input.attempt ?? 1;
  return `stageflow-${runId}-${stageId}-${attempt}-${suffix}`;
}

export function buildContainerRunArgs(params: {
  input: Pick<StageLaunchInput, "rootDir" | "runId" | "stageId">;
  cliArgs: string[];
  container: StageContainerOptions;
  env: Record<string, string | undefined>;
  containerName: string;
}): string[] {
  const { input, cliArgs, container, env, containerName } = params;
  const forwardEnvVars =
    container.forwardEnvVars ?? DEFAULT_STAGE_CONTAINER_FORWARD_ENV_VARS;

  // Mounted at the *same* absolute path as on the host (not a fixed
  // /workspace): the run store records absolute host paths for things
  // like the pipeline/task file location, and the worker resolves those
  // paths verbatim inside the container. A different mount point would
  // make every stored absolute path unresolvable in-container.
  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "-v",
    `${input.rootDir}:${input.rootDir}`,
  ];

  if (container.cacheRoot) {
    args.push(
      ...buildCacheMountArgs({
        runId: input.runId,
        stageId: input.stageId,
        cacheRoot: container.cacheRoot,
        cacheMounts: container.cacheMounts ?? [],
      }),
    );
  }

  args.push("-w", input.rootDir, "-e", SF_STAGE_WORKER);

  for (const name of forwardEnvVars) {
    if (env[name] !== undefined) {
      args.push("-e", name);
    }
  }

  args.push(container.image, ...cliArgs);
  return args;
}

function nextContainerNameSuffix(): string {
  return randomUUID().slice(0, 8);
}

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
  container?: StageContainerOptions;
};

function activeKey(runId: string, stageId: string): string {
  return `${runId}\0${stageId}`;
}

function isStageWorkerResult(value: unknown): value is StageWorkerResult {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: string }).type;
  return type === "succeeded" || type === "failed" || type === "waiting";
}

// `fallbackReason` is the last non-empty stderr line seen from the child.
// It's the only way to recover a specific failure reason when no worker
// message ever arrives (always true for a container-mode child: there is
// no IPC channel across the docker boundary to carry the real reason).
function resultFromExitCode(
  code: number | null,
  fallbackReason?: string,
): StageLaunchResult {
  if (code === STAGE_WORKER_EXIT.SUCCEEDED) {
    return { type: "succeeded" };
  }
  if (code === STAGE_WORKER_EXIT.WAITING) {
    return { type: "waiting" };
  }
  if (code === STAGE_WORKER_EXIT.FAILED) {
    return { type: "failed", reason: fallbackReason ?? "stage failed" };
  }
  return {
    type: "failed",
    reason:
      fallbackReason ??
      (code === null ? "stage process exited" : `stage process exit ${code}`),
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
  private readonly container: StageContainerOptions | undefined;
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
    this.container = resolveContainerOptions(this.env, options.container);
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
    if (input.operatorCatalog?.cwd !== undefined) {
      args.push("--operator-cwd", input.operatorCatalog.cwd);
    }
    if (input.operatorCatalog?.agentDir !== undefined) {
      args.push("--operator-agent-dir", input.operatorCatalog.agentDir);
    }
    if (input.skipGates) {
      args.push("--skip-gates");
    }

    const child = this.container
      ? this.spawnContainer(input, args, this.container)
      : this.spawnHostProcess(input, args);

    const key = activeKey(input.runId, input.stageId);
    const tracked: TrackedChild = {
      child,
      runId: input.runId,
      stageId: input.stageId,
      startedAt: Date.now(),
    };
    this.active.set(key, tracked);

    // Recovers a specific failure reason for a child with no IPC channel
    // (every container-mode child) by falling back to its last stderr
    // line — see resultFromExitCode.
    let lastStderrLine = "";

    if (child.stderr) {
      let stderrBuffer = "";
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrBuffer += chunk.toString();
        const lines = stderrBuffer.split("\n");
        stderrBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim().length > 0) lastStderrLine = line;
          process.stderr.write(`[stage:${input.stageId}] ${line}\n`);
        }
      });
      child.stderr.on("end", () => {
        if (stderrBuffer.length > 0) {
          if (stderrBuffer.trim().length > 0) lastStderrLine = stderrBuffer;
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
        finish(
          resultFromExitCode(
            code,
            lastStderrLine.length > 0 ? lastStderrLine : undefined,
          ),
        );
      });

      child.on("error", (err) => {
        finish({
          type: "failed",
          reason: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  private buildChildEnv(): Record<string, string | undefined> {
    return { ...process.env, ...this.env, [SF_STAGE_WORKER]: "1" };
  }

  private spawnHostProcess(
    input: StageLaunchInput,
    args: string[],
  ): ChildProcess {
    return fork(this.cliEntry, args, {
      cwd: input.rootDir,
      env: this.buildChildEnv(),
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    });
  }

  private spawnContainer(
    input: StageLaunchInput,
    args: string[],
    container: StageContainerOptions,
  ): ChildProcess {
    const env = this.buildChildEnv();
    const containerName = buildContainerName(input, nextContainerNameSuffix());
    const dockerArgs = buildContainerRunArgs({
      input,
      cliArgs: args,
      container,
      env,
      containerName,
    });
    return spawn(container.dockerBin ?? "docker", dockerArgs, {
      cwd: input.rootDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
}

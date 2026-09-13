import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

export const SANDBOX_CONTAINER_IMAGE_ENV = "STAGEFLOW_STAGE_CONTAINER_IMAGE";
export const SANDBOX_CONTAINER_DOCKER_BIN_ENV =
  "STAGEFLOW_STAGE_CONTAINER_DOCKER_BIN";

const execFileAsync = promisify(execFile);

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

export type SandboxContainerOptions = {
  image: string;
  dockerBin: string;
};

export function resolveSandboxContainerOptions(
  env: Record<string, string | undefined>,
  override?: { image: string; dockerBin?: string },
): SandboxContainerOptions | undefined {
  if (override) {
    if (!override.image || override.image.trim() === "") {
      throw new Error("sandboxContainer: image must be a non-empty string");
    }
    return { image: override.image, dockerBin: override.dockerBin || "docker" };
  }
  const image = env[SANDBOX_CONTAINER_IMAGE_ENV];
  if (!image || image.trim() === "") return undefined;
  return {
    image,
    dockerBin: env[SANDBOX_CONTAINER_DOCKER_BIN_ENV] || "docker",
  };
}

export function buildStartContainerArgs(params: {
  rootDir: string;
  image: string;
  containerName: string;
}): string[] {
  const { rootDir, image, containerName } = params;
  return [
    "run",
    "-d",
    "--name",
    containerName,
    "-v",
    `${rootDir}:${rootDir}`,
    "-w",
    rootDir,
    image,
    "sleep",
    "infinity",
  ];
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim().length > 0) return stderr;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function startSandboxContainer(params: {
  rootDir: string;
  image: string;
  runId: string;
  stageId: string;
  attempt?: number;
  dockerBin?: string;
}): Promise<{ containerName: string }> {
  const containerName = buildContainerName(
    { runId: params.runId, stageId: params.stageId, attempt: params.attempt },
    randomUUID().slice(0, 8),
  );
  const args = buildStartContainerArgs({
    rootDir: params.rootDir,
    image: params.image,
    containerName,
  });
  try {
    await execFileAsync(params.dockerBin ?? "docker", args);
  } catch (err) {
    throw new Error(`failed to start sandbox container: ${errorMessage(err)}`);
  }
  return { containerName };
}

const NO_SUCH_CONTAINER_PATTERN = /no such container/i;

export async function stopSandboxContainer(params: {
  containerName: string;
  dockerBin?: string;
}): Promise<void> {
  try {
    await execFileAsync(params.dockerBin ?? "docker", [
      "rm",
      "-f",
      params.containerName,
    ]);
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr?: unknown }).stderr ?? "")
        : "";
    if (NO_SUCH_CONTAINER_PATTERN.test(stderr)) return;
    throw new Error(`failed to stop sandbox container: ${errorMessage(err)}`);
  }
}

export async function execInSandboxContainer(params: {
  containerName: string;
  command: string;
  dockerBin?: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(params.dockerBin ?? "docker", [
      "exec",
      params.containerName,
      "bash",
      "-c",
      params.command,
    ]);
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string };
    // `code` is a number only for a completed exec that exited non-zero.
    // Anything else (ENOENT for a missing docker binary, the container
    // having been removed mid-exec, etc.) is an infra failure, not a
    // command result — rethrow so callers don't mistake it for "the
    // command ran and exited 1".
    if (typeof e.code !== "number") {
      throw new Error(`failed to exec in sandbox container: ${errorMessage(err)}`);
    }
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code };
  }
}

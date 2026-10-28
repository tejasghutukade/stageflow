import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

export const SANDBOX_CONTAINER_IMAGE_ENV = "STAGEFLOW_STAGE_CONTAINER_IMAGE";
export const SANDBOX_CONTAINER_DOCKER_BIN_ENV =
  "STAGEFLOW_STAGE_CONTAINER_DOCKER_BIN";
/** One host directory bind-mounted read-only into every stage sandbox, at the same path. */
export const STAGE_READONLY_DIR_ENV = "STAGEFLOW_STAGE_READONLY_DIR";

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

/** Fixed path inside the sandbox. The daemon owns the volume; we never pass it a path from this process. */
export const SANDBOX_MOUNT_PATH = "/workspace";

export function sandboxVolumeName(containerName: string): string {
  const safe = containerName.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `sf-bash-${safe}`;
}

export function stageReadOnlyDir(
  env: Record<string, string | undefined>,
): string | undefined {
  const raw = env[STAGE_READONLY_DIR_ENV];
  if (raw === undefined || raw.trim() === "") return undefined;
  return assertStageReadOnlyDir(raw);
}

export function assertStageReadOnlyDir(raw: string): string {
  const trimmed = raw.trim();
  if (!path.isAbsolute(trimmed)) {
    throw new Error(`${STAGE_READONLY_DIR_ENV} must be an absolute path`);
  }
  if (trimmed.includes("\0") || trimmed.includes(":")) {
    throw new Error(`${STAGE_READONLY_DIR_ENV} contains a character docker cannot mount`);
  }
  const resolved = path.resolve(trimmed);
  const parts = resolved.split(path.sep).filter((part) => part.length > 0);
  if (parts.length < 3) {
    throw new Error(`${STAGE_READONLY_DIR_ENV} is too broad`);
  }
  return resolved;
}

export async function assertStageReadOnlyDirExists(dir: string): Promise<void> {
  let info;
  try {
    info = await stat(dir);
  } catch {
    throw new Error(`read-only folder is not available: ${dir}`);
  }
  if (!info.isDirectory()) {
    throw new Error(`read-only folder is not a directory: ${dir}`);
  }
}

export function buildStartContainerArgs(params: {
  image: string;
  containerName: string;
  readOnlyDir?: string;
}): string[] {
  const { image, containerName } = params;
  const args = [
    "run",
    "-d",
    "--name",
    containerName,
    "-v",
    `${sandboxVolumeName(containerName)}:${SANDBOX_MOUNT_PATH}`,
  ];
  if (params.readOnlyDir !== undefined) {
    const dir = assertStageReadOnlyDir(params.readOnlyDir);
    args.push("-v", `${dir}:${dir}:ro`);
  }
  args.push("-w", SANDBOX_MOUNT_PATH, image, "sleep", "infinity");
  return args;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = (err as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim().length > 0) return stderr;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function startSandboxContainer(params: {
  image: string;
  runId: string;
  stageId: string;
  attempt?: number;
  dockerBin?: string;
  readOnlyDir?: string;
}): Promise<{ containerName: string }> {
  const containerName = buildContainerName(
    { runId: params.runId, stageId: params.stageId, attempt: params.attempt },
    randomUUID().slice(0, 8),
  );
  if (params.readOnlyDir !== undefined) {
    await assertStageReadOnlyDirExists(params.readOnlyDir);
  }
  const args = buildStartContainerArgs({
    image: params.image,
    containerName,
    ...(params.readOnlyDir !== undefined ? { readOnlyDir: params.readOnlyDir } : {}),
  });
  try {
    await execFileAsync(params.dockerBin ?? "docker", args);
  } catch (err) {
    throw new Error(`failed to start sandbox container: ${errorMessage(err)}`);
  }
  return { containerName };
}

const NO_SUCH_CONTAINER_PATTERN = /no such container/i;
const NO_SUCH_VOLUME_PATTERN = /no such volume/i;

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
    const stderr = stderrOf(err);
    if (!NO_SUCH_CONTAINER_PATTERN.test(stderr)) {
      throw new Error(`failed to stop sandbox container: ${errorMessage(err)}`);
    }
  }
  try {
    await execFileAsync(params.dockerBin ?? "docker", [
      "volume",
      "rm",
      sandboxVolumeName(params.containerName),
    ]);
  } catch (err) {
    const stderr = stderrOf(err);
    if (NO_SUCH_VOLUME_PATTERN.test(stderr)) return;
    throw new Error(`failed to remove sandbox volume: ${errorMessage(err)}`);
  }
}

function stderrOf(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    return String((err as { stderr?: unknown }).stderr ?? "");
  }
  return "";
}

export type SandboxExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export async function execInSandboxContainer(params: {
  containerName: string;
  command: string;
  dockerBin?: string;
  timeoutMs?: number;
}): Promise<SandboxExecResult> {
  const args = ["exec", "-w", SANDBOX_MOUNT_PATH, params.containerName, "bash", "-c", params.command];
  try {
    const { stdout, stderr } = await execFileAsync(params.dockerBin ?? "docker", args, {
      maxBuffer: 8 * 1024 * 1024,
      ...(params.timeoutMs !== undefined ? { timeout: params.timeoutMs } : {}),
    });
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

export async function copyToSandboxContainer(params: {
  containerName: string;
  hostPath: string;
  containerPath: string;
  dockerBin?: string;
  contents?: boolean;
}): Promise<void> {
  const src = params.contents ? `${params.hostPath}/.` : params.hostPath;
  await dockerCp(params.dockerBin, src, `${params.containerName}:${params.containerPath}`, "into");
}

export async function copyFromSandboxContainer(params: {
  containerName: string;
  containerPath: string;
  hostPath: string;
  dockerBin?: string;
  contents?: boolean;
}): Promise<void> {
  const src = params.contents
    ? `${params.containerName}:${params.containerPath}/.`
    : `${params.containerName}:${params.containerPath}`;
  await dockerCp(params.dockerBin, src, params.hostPath, "from");
}

async function dockerCp(
  dockerBin: string | undefined,
  src: string,
  dest: string,
  direction: "into" | "from",
): Promise<void> {
  try {
    await execFileAsync(dockerBin ?? "docker", ["cp", src, dest]);
  } catch (err) {
    throw new Error(`failed to copy ${direction} sandbox: ${errorMessage(err)}`);
  }
}

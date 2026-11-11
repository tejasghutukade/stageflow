import { randomBytes } from "node:crypto";
import { open, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { REDACTION_SECRETS_FILENAME } from "../logging/namedSecrets.js";
import { execInSandboxContainer } from "../runtime/sandboxContainer.js";
import {
  confineSandboxPath,
  readSandboxFile,
  shellQuote,
  writeSandboxFile,
  type SandboxFileTarget,
} from "../runtime/sandboxFiles.js";
import {
  FUNCTION_IO_BYTES_MAX,
  assertJsonValue,
  type FunctionFileRoot,
  type JsonValue,
} from "./protocol.js";

export type FunctionFileGrant = {
  root: FunctionFileRoot;
  path: string;
  access: "read" | "write";
};

export type ContainerFileStat = {
  file: boolean;
  directory: boolean;
  device: boolean;
  size: number;
};

export type ContainerFiles = {
  realPath(containerPath: string): Promise<string>;
  stat(containerPath: string): Promise<ContainerFileStat | undefined>;
  readFile(containerPath: string, signal: AbortSignal): Promise<string>;
  writeFile(containerPath: string, content: string, signal: AbortSignal): Promise<void>;
};

export type FileCapabilityResult =
  | { ok: true; value: JsonValue }
  | { ok: false; code: string; message: string };

export type FileCapabilityInput = {
  op: "exists" | "stat" | "readText" | "readJson" | "write";
  root: string | undefined;
  filePath: string | undefined;
  content?: string;
  grants: readonly FunctionFileGrant[];
  artifactsRoot?: string;
  workspaceRoot?: string;
  projectRoot?: string;
  stageflowHome: string;
  containerName?: string;
  containerDockerBin?: string;
  containerFiles?: ContainerFiles;
  signal: AbortSignal;
  beforeCommit?: () => Promise<void> | void;
};

const FILE_DENIED = { ok: false as const, code: "permission_denied", message: "file access denied" };
const NOT_FOUND = { ok: false as const, code: "not_found", message: "file not found" };
const FILE_LIMIT = { ok: false as const, code: "file_limit", message: "file exceeds 1 MiB" };
const UNCERTAIN = {
  ok: false as const,
  code: "uncertain_outcome",
  message: "function write outcome is uncertain",
};
const CANCELLED = { ok: false as const, code: "cancelled", message: "function execution cancelled" };

export async function performFileCapability(input: FileCapabilityInput): Promise<FileCapabilityResult> {
  if (input.signal.aborted) return CANCELLED;
  const relative = relativeFilePath(input.filePath);
  if (!relative || (input.root !== "artifacts" && input.root !== "workspace")) return FILE_DENIED;
  const access = input.op === "write" ? "write" : "read";
  if (!grantAllows(input.grants, input.root, relative, access)) return FILE_DENIED;
  const rootPath = input.root === "artifacts" ? input.artifactsRoot : input.workspaceRoot;
  if (!rootPath) return FILE_DENIED;
  if (input.containerName) {
    const files =
      input.containerFiles ??
      dockerContainerFiles({ containerName: input.containerName, dockerBin: input.containerDockerBin });
    return containerCapability(input, files, rootPath, relative);
  }
  return hostCapability(input, rootPath, relative);
}

function dockerContainerFiles(target: SandboxFileTarget): ContainerFiles {
  return {
    async realPath(containerPath: string) {
      const confined = confineSandboxPath(containerPath);
      const result = await execInSandboxContainer({
        containerName: target.containerName,
        dockerBin: target.dockerBin,
        command: `realpath -- ${shellQuote(confined)}`,
      });
      if (result.exitCode !== 0) throw new Error("realpath failed");
      return result.stdout.trim();
    },
    async stat(containerPath: string) {
      const confined = confineSandboxPath(containerPath);
      const quoted = shellQuote(confined);
      const result = await execInSandboxContainer({
        containerName: target.containerName,
        dockerBin: target.dockerBin,
        command: `if [ ! -e ${quoted} ]; then exit 3; fi; stat -c '%F %s' ${quoted}`,
      });
      if (result.exitCode === 3) return undefined;
      if (result.exitCode !== 0) throw new Error("stat failed");
      const match = /^(.+)\s+(\d+)$/.exec(result.stdout.trim());
      if (!match) throw new Error("stat failed");
      const kind = match[1] ?? "";
      return {
        file: kind === "regular file" || kind === "regular empty file",
        directory: kind === "directory",
        device: kind.includes("device") || kind.includes("character") || kind.includes("block"),
        size: Number(match[2]),
      };
    },
    async readFile(containerPath: string, signal: AbortSignal) {
      if (signal.aborted) throw abortError();
      const text = await readSandboxFile(target, containerPath);
      if (signal.aborted) throw abortError();
      return text;
    },
    async writeFile(containerPath: string, content: string, signal: AbortSignal) {
      if (signal.aborted) throw abortError();
      await writeSandboxFile(target, containerPath, content);
      if (signal.aborted) throw abortError();
    },
  };
}

async function hostCapability(
  input: FileCapabilityInput,
  rootPath: string,
  relative: string,
): Promise<FileCapabilityResult> {
  let rootReal: string;
  try {
    rootReal = await realpath(rootPath);
  } catch {
    return FILE_DENIED;
  }
  const home = await canonical(input.stageflowHome);
  if (isSensitive(path.join(rootReal, relative), home, input.projectRoot)) return FILE_DENIED;
  const parent = path.resolve(rootReal, path.dirname(relative));
  let parentReal: string;
  try {
    parentReal = await realpath(parent);
  } catch {
    return relative === "." ? directoryResult(input, rootReal) : NOT_FOUND;
  }
  if (!isInside(rootReal, parentReal)) return FILE_DENIED;
  const candidate = path.join(parentReal, path.basename(path.resolve(rootReal, relative)));
  if (!isInside(rootReal, candidate) || isSensitive(candidate, home, input.projectRoot)) return FILE_DENIED;
  if (input.op === "write") return writeHost(input, rootReal, candidate, home);
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (error) {
    if (codeOf(error) === "ENOENT") {
      if (input.op === "exists") return { ok: true, value: false };
      return NOT_FOUND;
    }
    return FILE_DENIED;
  }
  if (!isInside(rootReal, real) || isSensitive(real, home, input.projectRoot)) return FILE_DENIED;
  if (real.startsWith(`${path.sep}dev${path.sep}`) || real === "/dev") return FILE_DENIED;
  let fh;
  try {
    fh = await open(real, "r");
    if (input.signal.aborted) return CANCELLED;
    const opened = await fh.stat();
    if (opened.isCharacterDevice() || opened.isBlockDevice()) return FILE_DENIED;
    const again = await realpath(candidate);
    if (!isInside(rootReal, again) || isSensitive(again, home, input.projectRoot)) return FILE_DENIED;
    const againStat = await stat(again);
    if (againStat.dev !== opened.dev || againStat.ino !== opened.ino) return FILE_DENIED;
    if (input.op === "exists") return { ok: true, value: true };
    if (input.op === "stat") {
      return {
        ok: true,
        value: { size: opened.size, file: opened.isFile(), directory: opened.isDirectory() },
      };
    }
    if (!opened.isFile()) return FILE_DENIED;
    if (opened.size > FUNCTION_IO_BYTES_MAX) return FILE_LIMIT;
    const data = await fh.readFile({ signal: input.signal });
    if (input.signal.aborted) return CANCELLED;
    return textResult(input.op, data);
  } catch (error) {
    if (input.signal.aborted || codeOf(error) === "ABORT_ERR" || (error as Error).name === "AbortError") {
      return CANCELLED;
    }
    if (codeOf(error) === "ENOENT") return input.op === "exists" ? { ok: true, value: false } : NOT_FOUND;
    return FILE_DENIED;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

async function writeHost(
  input: FileCapabilityInput,
  rootReal: string,
  target: string,
  home: string,
): Promise<FileCapabilityResult> {
  if (typeof input.content !== "string") return FILE_DENIED;
  if (Buffer.byteLength(input.content, "utf8") > FUNCTION_IO_BYTES_MAX) return FILE_LIMIT;
  if (isSensitive(target, home, input.projectRoot) || !isInside(rootReal, target)) return FILE_DENIED;
  if (input.signal.aborted) return UNCERTAIN;
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  if (!isInside(rootReal, temp) || isSensitive(temp, home, input.projectRoot)) return FILE_DENIED;
  let committed = false;
  try {
    const fh = await open(temp, "wx", 0o600);
    try {
      await fh.writeFile(input.content, { signal: input.signal });
    } finally {
      await fh.close();
    }
    if (input.signal.aborted) return UNCERTAIN;
    await input.beforeCommit?.();
    if (input.signal.aborted) return UNCERTAIN;
    const dirReal = await realpath(path.dirname(temp));
    if (!isInside(rootReal, dirReal) || !isInside(rootReal, target)) return FILE_DENIED;
    await rename(temp, target);
    committed = true;
    return { ok: true, value: true };
  } catch (error) {
    if (input.signal.aborted) return UNCERTAIN;
    if (codeOf(error) === "ABORT_ERR" || (error as Error).name === "AbortError") return UNCERTAIN;
    return FILE_DENIED;
  } finally {
    if (!committed) await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function containerCapability(
  input: FileCapabilityInput,
  files: ContainerFiles,
  rootPath: string,
  relative: string,
): Promise<FileCapabilityResult> {
  const root = posixPath(rootPath);
  const joined = path.posix.resolve(root, relative);
  let confined: string;
  try {
    confined = confineSandboxPath(joined);
  } catch {
    return FILE_DENIED;
  }
  if (!isPosixInside(root, confined) || isSensitive(confined, input.stageflowHome, input.projectRoot)) {
    return FILE_DENIED;
  }
  if (input.op === "write") return writeContainer(input, files, root, confined);
  let real: string;
  try {
    real = posixPath(await files.realPath(confined));
  } catch {
    return input.op === "exists" ? { ok: true, value: false } : NOT_FOUND;
  }
  if (!containerAllows(real, root, input)) return FILE_DENIED;
  let info: ContainerFileStat | undefined;
  try {
    info = await files.stat(real);
  } catch {
    return FILE_DENIED;
  }
  if (!info) return input.op === "exists" ? { ok: true, value: false } : NOT_FOUND;
  if (info.device) return FILE_DENIED;
  let again: string;
  try {
    again = posixPath(await files.realPath(confined));
  } catch {
    return FILE_DENIED;
  }
  if (again !== real || !containerAllows(again, root, input)) return FILE_DENIED;
  if (input.op === "exists") return { ok: true, value: true };
  if (input.op === "stat") {
    return { ok: true, value: { size: info.size, file: info.file, directory: info.directory } };
  }
  if (!info.file) return FILE_DENIED;
  if (info.size > FUNCTION_IO_BYTES_MAX) return FILE_LIMIT;
  if (input.signal.aborted) return CANCELLED;
  try {
    const text = await files.readFile(again, input.signal);
    if (input.signal.aborted) return CANCELLED;
    return textResult(input.op, Buffer.from(text, "utf8"));
  } catch {
    if (input.signal.aborted) return CANCELLED;
    return FILE_DENIED;
  }
}

async function writeContainer(
  input: FileCapabilityInput,
  files: ContainerFiles,
  root: string,
  target: string,
): Promise<FileCapabilityResult> {
  if (typeof input.content !== "string") return FILE_DENIED;
  if (Buffer.byteLength(input.content, "utf8") > FUNCTION_IO_BYTES_MAX) return FILE_LIMIT;
  const temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  if (!isPosixInside(root, temp) || isSensitive(temp, input.stageflowHome, input.projectRoot)) return FILE_DENIED;
  if (input.signal.aborted) return UNCERTAIN;
  let committed = false;
  try {
    await files.writeFile(temp, input.content, input.signal);
    if (input.signal.aborted) return UNCERTAIN;
    await input.beforeCommit?.();
    if (input.signal.aborted) return UNCERTAIN;
    const dir = posixPath(await files.realPath(path.posix.dirname(temp)));
    if (!isPosixInside(root, dir)) return FILE_DENIED;
    await files.writeFile(target, input.content, input.signal);
    committed = true;
    return { ok: true, value: true };
  } catch {
    if (input.signal.aborted) return UNCERTAIN;
    return FILE_DENIED;
  } finally {
    if (!committed) {
      await files.writeFile(temp, "", input.signal).catch(() => undefined);
    }
  }
}

function containerAllows(real: string, root: string, input: FileCapabilityInput): boolean {
  try {
    confineSandboxPath(real);
  } catch {
    return false;
  }
  return isPosixInside(root, real) && !isSensitive(real, input.stageflowHome, input.projectRoot) && !real.startsWith("/dev/");
}

async function directoryResult(input: FileCapabilityInput, rootReal: string): Promise<FileCapabilityResult> {
  if (input.op === "exists") return { ok: true, value: true };
  if (input.op === "stat") {
    const opened = await stat(rootReal);
    return { ok: true, value: { size: opened.size, file: false, directory: true } };
  }
  return FILE_DENIED;
}

function textResult(op: "readText" | "readJson", data: Buffer): FileCapabilityResult {
  if (data.byteLength > FUNCTION_IO_BYTES_MAX) return FILE_LIMIT;
  const text = data.toString("utf8");
  if (op === "readText") return { ok: true, value: text };
  try {
    const parsed = JSON.parse(text) as unknown;
    const checked = assertJsonValue(parsed);
    if (!checked.ok) return { ok: false, code: "invalid_output", message: "file is not JSON" };
    return { ok: true, value: checked.value };
  } catch {
    return { ok: false, code: "invalid_output", message: "file is not JSON" };
  }
}

function grantAllows(
  grants: readonly FunctionFileGrant[],
  root: FunctionFileRoot,
  relative: string,
  access: "read" | "write",
): boolean {
  return grants.some((grant) => {
    if (grant.root !== root) return false;
    if (access === "write" ? grant.access !== "write" : grant.access !== "read" && grant.access !== "write") {
      return false;
    }
    const prefix = grant.path === "" || grant.path === "." ? "." : relativeFilePath(grant.path);
    if (prefix === undefined) return false;
    if (prefix === ".") return true;
    return relative === prefix || relative.startsWith(`${prefix}/`);
  });
}

function relativeFilePath(input: string | undefined): string | undefined {
  if (typeof input !== "string" || input.length === 0 || input.length > 4096) return undefined;
  const slashed = input.replaceAll("\\", "/");
  if (slashed.includes("\0") || slashed.startsWith("/") || slashed.startsWith("~") || /^[A-Za-z]:/.test(slashed)) {
    return undefined;
  }
  if (slashed.split("/").includes("..")) return undefined;
  const normalized = path.posix.normalize(slashed);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized.includes("\0")
  ) {
    return undefined;
  }
  return normalized;
}

function isSensitive(filePath: string, home: string, projectRoot: string | undefined): boolean {
  const parts = filePath.replaceAll("\\", "/").split("/").filter(Boolean);
  const base = parts[parts.length - 1] ?? "";
  if (base === "auth.json" || base === REDACTION_SECRETS_FILENAME) return true;
  if (parts.includes(".stageflow")) return true;
  const attemptsAt = parts.lastIndexOf("attempts");
  if (attemptsAt >= 0 && parts[attemptsAt + 2] === "credentials") return true;
  if (home && isInside(home, filePath)) return true;
  if (projectRoot && isInside(path.join(projectRoot, ".stageflow"), filePath)) return true;
  return false;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isPosixInside(root: string, target: string): boolean {
  const relative = path.posix.relative(posixPath(root), posixPath(target));
  return relative === "" || (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative));
}

function posixPath(filePath: string): string {
  const slashed = filePath.replaceAll("\\", "/");
  return path.posix.normalize(slashed.startsWith("/") ? slashed : `/${slashed}`);
}

async function canonical(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

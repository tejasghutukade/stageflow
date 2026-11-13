import { randomBytes } from "node:crypto";
import { lstat, open, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isFunctionDefinitionFile } from "../config/loadFunction.js";
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

export type ContainerListEntry = {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
};

export type ContainerFiles = {
  realPath(containerPath: string): Promise<string>;
  stat(containerPath: string): Promise<ContainerFileStat | undefined>;
  readFile(containerPath: string, signal: AbortSignal): Promise<string>;
  writeFile(containerPath: string, content: string, signal: AbortSignal): Promise<void>;
  list(containerPath: string): Promise<ContainerListEntry[]>;
};

export type FileCapabilityResult =
  | { ok: true; value: JsonValue }
  | { ok: false; code: string; message: string };

export type FileCapabilityInput = {
  op: "exists" | "stat" | "readText" | "readJson" | "list" | "write";
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
const NOT_A_DIRECTORY = { ok: false as const, code: "not_a_directory", message: "not a directory" };
const LIST_LIMIT = { ok: false as const, code: "list_limit", message: "directory has more than 1000 entries" };
const LIST_MAX = 1000;
const FILE_LIMIT = { ok: false as const, code: "file_limit", message: "file exceeds 1 MiB" };
const UNCERTAIN = {
  ok: false as const,
  code: "uncertain_outcome",
  message: "function write outcome is uncertain",
};
const CANCELLED = { ok: false as const, code: "cancelled", message: "function execution cancelled" };

export async function performFileCapability(input: FileCapabilityInput): Promise<FileCapabilityResult> {
  if (input.signal.aborted) return CANCELLED;
  const relative =
    input.op === "list" && (input.filePath === "" || input.filePath === ".") ? "." : relativeFilePath(input.filePath);
  if (!relative || (input.root !== "artifacts" && input.root !== "workspace")) return FILE_DENIED;
  const access = input.op === "write" ? "write" : "read";
  if (!grantAllows(input.grants, input.root, relative, access)) return FILE_DENIED;
  const rootPath = input.root === "artifacts" ? input.artifactsRoot : input.workspaceRoot;
  if (!rootPath) return FILE_DENIED;
  if (input.containerName && rootUsesContainerOps(rootPath)) {
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
    async list(containerPath: string) {
      const confined = confineSandboxPath(containerPath);
      const quoted = shellQuote(confined);
      const result = await execInSandboxContainer({
        containerName: target.containerName,
        dockerBin: target.dockerBin,
        command: `find -- ${quoted} -mindepth 1 -maxdepth 1 -printf '%y %s %f\\0'`,
      });
      if (result.exitCode !== 0) throw new Error("list failed");
      return parseContainerList(result.stdout);
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
  if (input.op === "list" && relative === ".") {
    if (isSensitive(rootReal, home, input.projectRoot)) return FILE_DENIED;
    return listHost(input, rootReal, rootReal, home);
  }
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
  if (input.op === "list") return listHost(input, rootReal, candidate, home);
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

const PROTECTED_CATALOG_WRITES: readonly {
  directory: string;
  matches: (relativePath: string) => boolean;
}[] = [
  {
    directory: "agents",
    matches: (relativePath) => relativePath.toLowerCase().endsWith(".agent.yaml"),
  },
  {
    directory: "functions",
    matches: isFunctionDefinitionFile,
  },
];

async function denyCatalogDefinitionWorkspaceWrite(
  input: FileCapabilityInput,
  parentFallback: string,
  fileName: string,
  resolveParent: () => Promise<string>,
): Promise<FileCapabilityResult | undefined> {
  if (input.root !== "workspace") return undefined;
  let parentResolved: string;
  try {
    parentResolved = await resolveParent();
  } catch {
    parentResolved = parentFallback;
  }
  if (await isForbiddenCatalogWrite(input.projectRoot, input.workspaceRoot, parentResolved, fileName)) {
    return FILE_DENIED;
  }
  return undefined;
}

async function writeHost(
  input: FileCapabilityInput,
  rootReal: string,
  target: string,
  home: string,
): Promise<FileCapabilityResult> {
  if (typeof input.content !== "string") return FILE_DENIED;
  if (Buffer.byteLength(input.content, "utf8") > FUNCTION_IO_BYTES_MAX) return FILE_LIMIT;
  const denied = await denyCatalogDefinitionWorkspaceWrite(
    input,
    path.dirname(target),
    path.basename(target),
    () => realpath(path.dirname(target)),
  );
  if (denied) return denied;
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
  if (input.op === "list") return listContainer(input, files, root, again, info);
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
  const denied = await denyCatalogDefinitionWorkspaceWrite(
    input,
    path.posix.dirname(target),
    path.posix.basename(target),
    async () => posixPath(await files.realPath(path.posix.dirname(target))),
  );
  if (denied) return denied;
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

async function listHost(
  input: FileCapabilityInput,
  rootReal: string,
  candidate: string,
  home: string,
): Promise<FileCapabilityResult> {
  let real: string;
  try {
    real = await realpath(candidate);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return NOT_FOUND;
    return FILE_DENIED;
  }
  if (!listPathAllowed(real, rootReal, home, input.projectRoot)) return FILE_DENIED;
  let fh;
  try {
    fh = await open(real, "r");
    if (input.signal.aborted) return CANCELLED;
    const opened = await fh.stat();
    if (opened.isCharacterDevice() || opened.isBlockDevice() || opened.isSocket() || opened.isFIFO()) return FILE_DENIED;
    const again = await realpath(candidate);
    if (!listPathAllowed(again, rootReal, home, input.projectRoot)) return FILE_DENIED;
    const againStat = await stat(again);
    if (againStat.dev !== opened.dev || againStat.ino !== opened.ino) return FILE_DENIED;
    if (!opened.isDirectory()) return NOT_A_DIRECTORY;
    const dirents = await readdir(again, { withFileTypes: true });
    if (dirents.length > LIST_MAX) return LIST_LIMIT;
    const rows: ListRow[] = [];
    for (const dirent of dirents) {
      const child = path.join(again, dirent.name);
      try {
        if (isSensitive(child, home, input.projectRoot)) continue;
        if (dirent.isSymbolicLink()) {
          const followed = await followListLink(child, rootReal, home, input.projectRoot);
          if (followed) rows.push({ name: dirent.name, ...followed });
          continue;
        }
        if (dirent.isSocket() || dirent.isCharacterDevice() || dirent.isBlockDevice() || dirent.isFIFO()) continue;
        const info = await lstat(child);
        if (info.isDirectory()) rows.push({ name: dirent.name, type: "directory", size: info.size });
        else if (info.isFile()) rows.push({ name: dirent.name, type: "file", size: info.size });
      } catch {
        continue;
      }
    }
    const confirmed = await realpath(candidate);
    if (confirmed !== again || !listPathAllowed(confirmed, rootReal, home, input.projectRoot)) return FILE_DENIED;
    return listValue(rows);
  } catch (error) {
    if (input.signal.aborted || codeOf(error) === "ABORT_ERR" || (error as Error).name === "AbortError") return CANCELLED;
    if (codeOf(error) === "ENOTDIR") return NOT_A_DIRECTORY;
    if (codeOf(error) === "ENOENT") return NOT_FOUND;
    return FILE_DENIED;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

async function followListLink(
  child: string,
  rootReal: string,
  home: string,
  projectRoot: string | undefined,
): Promise<{ type: "file" | "directory"; size: number } | undefined> {
  let target: string;
  try {
    target = await realpath(child);
  } catch {
    return undefined;
  }
  if (!listPathAllowed(target, rootReal, home, projectRoot)) return undefined;
  let info;
  try {
    info = await stat(target);
  } catch {
    return undefined;
  }
  let again: string;
  try {
    again = await realpath(child);
  } catch {
    return undefined;
  }
  if (again !== target || !listPathAllowed(again, rootReal, home, projectRoot)) return undefined;
  if (info.isSocket() || info.isCharacterDevice() || info.isBlockDevice() || info.isFIFO()) return undefined;
  if (info.isDirectory()) return { type: "directory", size: info.size };
  if (info.isFile()) return { type: "file", size: info.size };
  return undefined;
}

async function listContainer(
  input: FileCapabilityInput,
  files: ContainerFiles,
  root: string,
  directory: string,
  info: ContainerFileStat,
): Promise<FileCapabilityResult> {
  if (!info.directory) return NOT_A_DIRECTORY;
  let entries: ContainerListEntry[];
  try {
    entries = await files.list(directory);
  } catch {
    return FILE_DENIED;
  }
  if (entries.length > LIST_MAX) return LIST_LIMIT;
  let again: string;
  try {
    again = posixPath(await files.realPath(directory));
  } catch {
    return FILE_DENIED;
  }
  if (again !== directory || !containerAllows(again, root, input)) return FILE_DENIED;
  const rows: ListRow[] = [];
  for (const entry of entries) {
    if (!entry.name || entry.name === "." || entry.name === ".." || entry.name.includes("/") || entry.name.includes("\0")) {
      continue;
    }
    const child = path.posix.join(directory, entry.name);
    if (isSensitive(child, input.stageflowHome, input.projectRoot)) continue;
    if (entry.type === "other") continue;
    if (entry.type === "symlink") {
      const followed = await followContainerLink(files, child, root, input);
      if (followed) rows.push({ name: entry.name, ...followed });
      continue;
    }
    if (entry.type === "directory") rows.push({ name: entry.name, type: "directory", size: entry.size });
    else if (entry.type === "file") rows.push({ name: entry.name, type: "file", size: entry.size });
  }
  return listValue(rows);
}

async function followContainerLink(
  files: ContainerFiles,
  child: string,
  root: string,
  input: FileCapabilityInput,
): Promise<{ type: "file" | "directory"; size: number } | undefined> {
  let target: string;
  try {
    target = posixPath(await files.realPath(child));
  } catch {
    return undefined;
  }
  if (!containerAllows(target, root, input)) return undefined;
  let info: ContainerFileStat | undefined;
  try {
    info = await files.stat(target);
  } catch {
    return undefined;
  }
  if (!info || info.device) return undefined;
  let again: string;
  try {
    again = posixPath(await files.realPath(child));
  } catch {
    return undefined;
  }
  if (again !== target || !containerAllows(again, root, input)) return undefined;
  if (info.directory) return { type: "directory", size: info.size };
  if (info.file) return { type: "file", size: info.size };
  return undefined;
}

function parseContainerList(stdout: string): ContainerListEntry[] {
  const entries: ContainerListEntry[] = [];
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    const match = /^([a-zA-Z]) (\d+) ([\s\S]*)$/.exec(record);
    if (!match?.[1] || match[2] === undefined || match[3] === undefined) continue;
    const flag = match[1];
    const type = flag === "f" ? "file" : flag === "d" ? "directory" : flag === "l" ? "symlink" : "other";
    entries.push({ name: match[3], type, size: Number(match[2]) });
  }
  return entries;
}

function listPathAllowed(target: string, rootReal: string, home: string, projectRoot: string | undefined): boolean {
  if (!isInside(rootReal, target) || isSensitive(target, home, projectRoot)) return false;
  return target !== "/dev" && !target.startsWith(`${path.sep}dev${path.sep}`);
}

type ListRow = { name: string; type: "file" | "directory"; size: number };

function listValue(rows: ListRow[]): FileCapabilityResult {
  rows.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  if (Buffer.byteLength(JSON.stringify(rows), "utf8") > FUNCTION_IO_BYTES_MAX) return FILE_LIMIT;
  return { ok: true, value: rows };
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
  if (home && isInside(home, filePath)) return !isInside(path.join(home, "runs"), filePath);
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

function rootUsesContainerOps(rootPath: string): boolean {
  const normalized = posixPath(rootPath);
  return normalized === "/workspace" || normalized.startsWith("/workspace/");
}

async function isForbiddenCatalogWrite(
  projectRoot: string | undefined,
  workspaceRoot: string | undefined,
  parentDir: string,
  fileName: string,
): Promise<boolean> {
  const catalogRoot = workspaceRoot ?? projectRoot;
  if (!catalogRoot) return false;
  let target = path.resolve(parentDir, fileName);
  try {
    target = await realpath(target);
  } catch {
    target = path.resolve(parentDir, fileName);
  }
  for (const location of PROTECTED_CATALOG_WRITES) {
    let directory = path.join(path.resolve(catalogRoot), location.directory);
    try {
      directory = await realpath(directory);
    } catch {}
    const relative = path.relative(directory, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    if (location.matches(relative)) return true;
  }
  return false;
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

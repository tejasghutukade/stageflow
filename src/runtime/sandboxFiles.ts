import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  copyToSandboxContainer,
  execInSandboxContainer,
  SANDBOX_MOUNT_PATH,
  type SandboxExecResult,
} from "./sandboxContainer.js";

export class SandboxPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPathError";
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Resolve a tool path onto the sandbox mount. Host absolutes and `..` escapes are rejected. */
export function confineSandboxPath(inputPath: string): string {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new SandboxPathError("path must be a non-empty string");
  }
  if (inputPath.includes("\0") || inputPath.startsWith("~")) {
    throw new SandboxPathError("path escapes the sandbox");
  }
  const slashes = inputPath.replaceAll("\\", "/");
  const joined = slashes.startsWith("/")
    ? path.posix.normalize(slashes)
    : path.posix.normalize(path.posix.join(SANDBOX_MOUNT_PATH, slashes));
  if (joined !== SANDBOX_MOUNT_PATH && !joined.startsWith(`${SANDBOX_MOUNT_PATH}/`)) {
    throw new SandboxPathError("path escapes the sandbox");
  }
  return joined;
}

export type SandboxFileTarget = {
  containerName: string;
  dockerBin?: string;
};

function assertFilePath(containerPath: string): void {
  if (containerPath === SANDBOX_MOUNT_PATH) {
    throw new SandboxPathError("path must name a file under /workspace");
  }
}

async function requireExec(result: SandboxExecResult, fallback: string): Promise<void> {
  if (result.exitCode === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim();
  throw new Error(detail || fallback);
}

export async function readSandboxFile(
  target: SandboxFileTarget,
  inputPath: string,
): Promise<string> {
  const containerPath = confineSandboxPath(inputPath);
  assertFilePath(containerPath);
  const quoted = shellQuote(containerPath);
  const result = await execInSandboxContainer({
    containerName: target.containerName,
    dockerBin: target.dockerBin,
    command: `if [ ! -f ${quoted} ]; then echo "No such file: ${containerPath}" >&2; exit 1; fi; base64 < ${quoted}`,
  });
  await requireExec(result, `failed to read ${containerPath}`);
  return Buffer.from(result.stdout, "base64").toString("utf8");
}

export async function writeSandboxFile(
  target: SandboxFileTarget,
  inputPath: string,
  content: string,
): Promise<void> {
  const containerPath = confineSandboxPath(inputPath);
  assertFilePath(containerPath);
  const parent = path.posix.dirname(containerPath);
  const made = await execInSandboxContainer({
    containerName: target.containerName,
    dockerBin: target.dockerBin,
    command: `mkdir -p -- ${shellQuote(parent)}`,
  });
  await requireExec(made, `failed to write ${containerPath}`);
  const scratch = await mkdtemp(path.join(tmpdir(), "sf-sandbox-write-"));
  const payload = path.join(scratch, "payload");
  try {
    await writeFile(payload, content);
    await copyToSandboxContainer({
      containerName: target.containerName,
      dockerBin: target.dockerBin,
      hostPath: payload,
      containerPath,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function editSandboxFile(
  target: SandboxFileTarget,
  inputPath: string,
  edits: readonly { oldText: string; newText: string }[],
): Promise<void> {
  if (edits.length === 0) {
    throw new Error("edits must contain at least one replacement");
  }
  const original = await readSandboxFile(target, inputPath);
  const ranges: Array<{ start: number; end: number; newText: string }> = [];
  for (const edit of edits) {
    if (edit.oldText.length === 0) {
      throw new Error("oldText must not be empty");
    }
    const count = countOccurrences(original, edit.oldText);
    if (count !== 1) {
      throw new Error(`oldText matched ${count} times`);
    }
    const start = original.indexOf(edit.oldText);
    ranges.push({ start, end: start + edit.oldText.length, newText: edit.newText });
  }
  ranges.sort((a, b) => b.start - a.start);
  for (let i = 0; i < ranges.length; i += 1) {
    const later = ranges[i]!;
    for (let j = i + 1; j < ranges.length; j += 1) {
      const earlier = ranges[j]!;
      if (earlier.end > later.start) {
        throw new Error("edits overlap");
      }
    }
  }
  let next = original;
  for (const range of ranges) {
    next = next.slice(0, range.start) + range.newText + next.slice(range.end);
  }
  await writeSandboxFile(target, inputPath, next);
}

export function sliceSandboxLines(text: string, offset?: number, limit?: number): string {
  if (offset === undefined && limit === undefined) return text;
  const lines = text.split("\n");
  const start = offset !== undefined ? Math.max(0, Math.floor(offset) - 1) : 0;
  if (start >= lines.length) {
    throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines total)`);
  }
  const end = limit !== undefined ? start + Math.max(0, Math.floor(limit)) : lines.length;
  return lines.slice(start, end).join("\n");
}

export function formatSandboxBashResult(result: SandboxExecResult): string {
  const parts = [result.stdout];
  if (result.stderr.trim().length > 0) parts.push(result.stderr);
  parts.push(`Exit code: ${result.exitCode}`);
  return parts.join("\n");
}

export async function runSandboxBash(
  target: SandboxFileTarget,
  command: string,
  timeoutMs?: number,
): Promise<string> {
  const result = await execInSandboxContainer({
    containerName: target.containerName,
    dockerBin: target.dockerBin,
    command,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
  return formatSandboxBashResult(result);
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
  return count;
}

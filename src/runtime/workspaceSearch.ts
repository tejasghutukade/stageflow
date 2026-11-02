import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { classifyRealPathContainment } from "../runstore/workspaceLayout.js";
import {
  execInSandboxContainer,
  SANDBOX_MOUNT_PATH,
  type SandboxExecResult,
} from "./sandboxContainer.js";
import { confineSandboxSearchPath, shellQuote } from "./sandboxFiles.js";

const execFileAsync = promisify(execFile);

const GREP_DEFAULT_LIMIT = 100;
const FIND_DEFAULT_LIMIT = 1000;
const LS_DEFAULT_LIMIT = 500;

export type CommandRunner = (command: string) => Promise<SandboxExecResult>;

export type SandboxCommandTarget = {
  containerName: string;
  dockerBin?: string;
  readonlyDir?: string;
  execute?: (params: {
    containerName: string;
    command: string;
    dockerBin?: string;
    timeoutMs?: number;
  }) => Promise<SandboxExecResult>;
};

export type GrepQuery = {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
};

export type FindQuery = {
  pattern: string;
  path?: string;
  limit?: number;
};

export type LsQuery = {
  path?: string;
  limit?: number;
};

function positiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  return floored < 1 ? 1 : floored;
}

function requirePattern(pattern: string): void {
  if (typeof pattern !== "string" || pattern.trim() === "" || pattern.includes("\0")) {
    throw new Error("pattern must be a non-empty string");
  }
}

export function confineWorkingTreePath(cwd: string, inputPath: string | undefined): string {
  const root = path.resolve(cwd);
  if (inputPath === undefined || inputPath === ".") return root;
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new Error("path must be a non-empty string");
  }
  if (inputPath.includes("\0") || inputPath.startsWith("~")) {
    throw new Error("path escapes the working tree");
  }
  const resolved = path.resolve(root, inputPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("path escapes the working tree");
  }
  return resolved;
}

export async function resolveHostSearchPath(cwd: string, inputPath: string | undefined): Promise<string> {
  const root = path.resolve(cwd);
  const resolved = confineWorkingTreePath(cwd, inputPath);
  let linked = false;
  try {
    linked = (await lstat(resolved)).isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return resolved;
    throw err;
  }
  if (linked) throw new Error("path escapes the working tree");
  const containment = await classifyRealPathContainment(resolved, root);
  if (containment.status === "outside") throw new Error("path escapes the working tree");
  return resolved;
}

export function resolveSandboxSearchPath(inputPath: string | undefined, readonlyDir?: string): string {
  if (inputPath === undefined || inputPath === ".") return SANDBOX_MOUNT_PATH;
  return confineSandboxSearchPath(inputPath, readonlyDir);
}

export function sandboxCommandRunner(target: SandboxCommandTarget): CommandRunner {
  const execute = target.execute ?? execInSandboxContainer;
  return (command) =>
    execute({
      containerName: target.containerName,
      command,
      dockerBin: target.dockerBin,
    });
}

export async function runHostShell(cwd: string, command: string): Promise<SandboxExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
      cwd,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr), exitCode: 0 };
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; code?: number | string };
    if (typeof failed.code !== "number") {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`search could not run: ${message}`);
    }
    return {
      stdout: String(failed.stdout ?? ""),
      stderr: String(failed.stderr ?? ""),
      exitCode: failed.code,
    };
  }
}

function capLines(text: string, limit: number): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length <= limit) return lines.join("\n");
  return `${lines.slice(0, limit).join("\n")}\n[${lines.length - limit} more lines omitted]`;
}

function commandFailure(result: SandboxExecResult, fallback: string): Error {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new Error(detail || fallback);
}

export function grepCommand(searchPath: string, query: GrepQuery): string {
  requirePattern(query.pattern);
  const flags = ["-R", "-n", "-I", "--exclude-dir=.git", "--exclude-dir=node_modules"];
  if (query.ignoreCase) flags.push("-i");
  flags.push(query.literal ? "-F" : "-E");
  if (query.glob !== undefined && query.glob !== "") {
    flags.push(`--include=${shellQuote(query.glob)}`);
  }
  if (query.context !== undefined && Number.isFinite(query.context) && query.context > 0) {
    flags.push("-C", String(Math.floor(query.context)));
  }
  flags.push("-m", String(positiveInt(query.limit, GREP_DEFAULT_LIMIT)));
  return `grep ${flags.join(" ")} -e ${shellQuote(query.pattern)} -- ${shellQuote(searchPath)}`;
}

const FIND_SCRIPT = [
  "const fs = require('fs');",
  "const path = require('path');",
  "const root = process.env.SF_SEARCH_ROOT;",
  "const pattern = process.env.SF_SEARCH_PATTERN;",
  "const limit = Number(process.env.SF_SEARCH_LIMIT);",
  "function globToRegExp(glob) {",
  "  let out = '^';",
  "  for (let i = 0; i < glob.length; i += 1) {",
  "    const c = glob[i];",
  "    if (c === '*' && glob[i + 1] === '*') {",
  "      if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }",
  "      else { out += '.*'; i += 1; }",
  "      continue;",
  "    }",
  "    if (c === '*') out += '[^/]*';",
  "    else if (c === '?') out += '[^/]';",
  "    else if ('\\\\.+^${}()|[]'.indexOf(c) >= 0) out += '\\\\' + c;",
  "    else out += c;",
  "  }",
  "  return new RegExp(out + '$');",
  "}",
  "const matchPath = pattern.includes('/') || pattern.includes('**');",
  "const re = globToRegExp(pattern);",
  "const hits = [];",
  "function consider(rel, name) {",
  "  if (hits.length >= limit) return;",
  "  if (re.test(matchPath ? rel : name)) hits.push(rel);",
  "}",
  "const rootStat = fs.lstatSync(root);",
  "if (rootStat.isSymbolicLink()) {",
  "  process.stderr.write('path escapes the working tree\\n');",
  "  process.exit(1);",
  "}",
  "if (rootStat.isFile()) consider(path.basename(root), path.basename(root));",
  "else {",
  "  function walk(dir) {",
  "    if (hits.length >= limit) return;",
  "    let entries;",
  "    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }",
  "    catch (err) { if (dir === root) throw err; return; }",
  "    entries.sort((a, b) => a.name.localeCompare(b.name));",
  "    for (const entry of entries) {",
  "      if (hits.length >= limit) return;",
  "      if (entry.name === '.git' || entry.name === 'node_modules') continue;",
  "      if (entry.isSymbolicLink()) continue;",
  "      const full = path.join(dir, entry.name);",
  "      if (entry.isDirectory()) walk(full);",
  "      else if (entry.isFile()) {",
  "        const rel = path.relative(root, full).split(path.sep).join('/');",
  "        consider(rel, entry.name);",
  "      }",
  "    }",
  "  }",
  "  walk(root);",
  "}",
  "process.stdout.write(hits.join('\\n'));",
].join("");

export function findCommand(searchPath: string, query: FindQuery): string {
  requirePattern(query.pattern);
  const limit = positiveInt(query.limit, FIND_DEFAULT_LIMIT);
  return [
    `SF_SEARCH_ROOT=${shellQuote(searchPath)}`,
    `SF_SEARCH_PATTERN=${shellQuote(query.pattern)}`,
    `SF_SEARCH_LIMIT=${limit}`,
    `node -e ${shellQuote(FIND_SCRIPT)}`,
  ].join(" ");
}

export function lsCommand(searchPath: string): string {
  const quoted = shellQuote(searchPath);
  const escaped = shellQuote("path escapes the working tree");
  const message = shellQuote(`Not a directory: ${searchPath}`);
  return `if [ -L ${quoted} ]; then printf '%s\\n' ${escaped} >&2; exit 1; fi; if [ ! -d ${quoted} ]; then printf '%s\\n' ${message} >&2; exit 1; fi; ls -1Ap -- ${quoted}`;
}

export async function runGrep(
  searchPath: string,
  query: GrepQuery,
  run: CommandRunner,
): Promise<string> {
  const result = await run(grepCommand(searchPath, query));
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw commandFailure(result, "grep failed");
  }
  const text = capLines(result.stdout, positiveInt(query.limit, GREP_DEFAULT_LIMIT));
  return text.trim() === "" ? "No matches found" : text;
}

export async function runFind(
  searchPath: string,
  query: FindQuery,
  run: CommandRunner,
): Promise<string> {
  const result = await run(findCommand(searchPath, query));
  if (result.exitCode !== 0) throw commandFailure(result, "find failed");
  const text = capLines(result.stdout, positiveInt(query.limit, FIND_DEFAULT_LIMIT));
  return text.trim() === "" ? "No files found" : text;
}

export async function runLs(searchPath: string, query: LsQuery, run: CommandRunner): Promise<string> {
  const result = await run(lsCommand(searchPath));
  if (result.exitCode !== 0) throw commandFailure(result, "ls failed");
  return capLines(result.stdout, positiveInt(query.limit, LS_DEFAULT_LIMIT));
}

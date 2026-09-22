import { execFile, execFileSync } from "node:child_process";
import {
  classifyGitFailure,
  GitError,
  redactGitText,
  type GitErrorCode,
} from "./errors.js";

export type RunGitOptions = {
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
  gitBin?: string;
  signal?: AbortSignal;
};

export type RunGitResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

function buildEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function toErrorMessage(code: GitErrorCode): string {
  switch (code) {
    case "auth_failed":
      return "git authentication failed";
    case "ref_not_found":
      return "git ref not found";
    case "repo_not_found":
      return "git repository not found";
    case "network":
      return "git network error";
    case "disk_full":
      return "git disk full";
    case "git_missing":
      return "git binary not found";
    case "timeout":
      return "git command timed out";
    default:
      return "git command failed";
  }
}

function fail(options: {
  argv: string[];
  stderrRaw: string;
  exitCode: number | null;
  errno?: string | null;
  timedOut?: boolean;
  env: NodeJS.ProcessEnv;
}): never {
  const stderr = redactGitText(options.stderrRaw, options.env);
  const code = classifyGitFailure({
    stderr: options.stderrRaw,
    exitCode: options.exitCode,
    errno: options.errno,
    timedOut: options.timedOut,
  });
  throw new GitError(toErrorMessage(code), {
    code,
    argv: options.argv,
    stderr,
    exitCode: options.exitCode,
  });
}

function normalizeStderr(stderr: unknown): string {
  if (Buffer.isBuffer(stderr)) return stderr.toString("utf8").trim();
  if (typeof stderr === "string") return stderr.trim();
  return "";
}

export function runGitSync(options: RunGitOptions): RunGitResult {
  const gitBin = options.gitBin ?? "git";
  const argv = [gitBin, ...options.args];
  const env = buildEnv(options.env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const stdout = execFileSync(gitBin, options.args, {
      cwd: options.cwd,
      env,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      status?: number | null;
      signal?: string | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      killed?: boolean;
    };
    const timedOut =
      err.killed === true ||
      err.signal === "SIGTERM" ||
      (typeof err.message === "string" && /TIMEDOUT|timed out/i.test(err.message));
    fail({
      argv,
      stderrRaw: normalizeStderr(err.stderr) || (timedOut ? "git command timed out" : err.message),
      exitCode: typeof err.status === "number" ? err.status : null,
      errno: err.code ?? null,
      timedOut,
      env,
    });
  }
}

export function runGit(options: RunGitOptions): Promise<RunGitResult> {
  const gitBin = options.gitBin ?? "git";
  const argv = [gitBin, ...options.args];
  const env = buildEnv(options.env);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    execFile(
      gitBin,
      options.args,
      {
        cwd: options.cwd,
        env,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        signal: options.signal,
        killSignal: "SIGTERM",
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({
            stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
            stderr: normalizeStderr(stderr),
            exitCode: 0,
          });
          return;
        }
        const err = error as NodeJS.ErrnoException & {
          code?: string | number;
          killed?: boolean;
          signal?: string | null;
          status?: number | null;
        };
        const timedOut =
          err.killed === true ||
          err.signal === "SIGTERM" ||
          err.code === "ETIMEDOUT" ||
          (typeof err.message === "string" && /TIMEDOUT|timed out/i.test(err.message));
        const errno = typeof err.code === "string" ? err.code : null;
        const exitCode =
          typeof err.status === "number"
            ? err.status
            : typeof err.code === "number"
              ? err.code
              : null;
        try {
          fail({
            argv,
            stderrRaw:
              normalizeStderr(stderr) ||
              (timedOut ? "git command timed out" : err.message),
            exitCode,
            errno,
            timedOut,
            env,
          });
        } catch (gitError) {
          reject(gitError);
        }
      },
    );
  });
}

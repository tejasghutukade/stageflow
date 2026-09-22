import { runGit, runGitSync, type RunGitOptions } from "./exec.js";

const TIMEOUT = {
  resolve: 30_000,
  worktree: 120_000,
  fetch: 300_000,
  clone: 900_000,
  default: 30_000,
} as const;

export type GitCallOptions = {
  env?: NodeJS.ProcessEnv;
  gitBin?: string;
  signal?: AbortSignal;
};

function baseOpts(
  cwd: string | undefined,
  args: string[],
  timeoutMs: number,
  opts?: GitCallOptions,
): RunGitOptions {
  return {
    cwd,
    args,
    timeoutMs,
    env: opts?.env,
    gitBin: opts?.gitBin,
    signal: opts?.signal,
  };
}

export async function cloneBare(
  url: string,
  dest: string,
  opts?: GitCallOptions,
): Promise<void> {
  await runGit(baseOpts(undefined, ["clone", "--mirror", url, dest], TIMEOUT.clone, opts));
}

export async function fetch(
  repoDir: string,
  refspecs: string[] = [],
  opts?: GitCallOptions,
): Promise<void> {
  await runGit(
    baseOpts(repoDir, ["fetch", "--prune", "origin", ...refspecs], TIMEOUT.fetch, opts),
  );
}

export async function remoteUpdate(
  repoDir: string,
  opts?: GitCallOptions,
): Promise<void> {
  await runGit(
    baseOpts(repoDir, ["remote", "update", "--prune"], TIMEOUT.fetch, opts),
  );
}

export async function resolveRef(
  repoDir: string,
  ref: string,
  opts?: GitCallOptions,
): Promise<string> {
  const result = await runGit(
    baseOpts(
      repoDir,
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      TIMEOUT.resolve,
      opts,
    ),
  );
  return result.stdout.trim();
}

export async function catFileCommit(
  repoDir: string,
  sha: string,
  opts?: GitCallOptions,
): Promise<boolean> {
  try {
    await runGit(
      baseOpts(repoDir, ["cat-file", "-e", `${sha}^{commit}`], TIMEOUT.resolve, opts),
    );
    return true;
  } catch {
    return false;
  }
}

export async function worktreeAdd(
  repoDir: string,
  input: { worktreePath: string; branch: string; startPoint: string },
  opts?: GitCallOptions,
): Promise<void> {
  await runGit(
    baseOpts(
      repoDir,
      ["worktree", "add", "-b", input.branch, input.worktreePath, input.startPoint],
      TIMEOUT.worktree,
      opts,
    ),
  );
}

export async function worktreeRemove(
  repoDir: string,
  worktreePath: string,
  opts?: GitCallOptions,
): Promise<void> {
  await runGit(
    baseOpts(
      repoDir,
      ["worktree", "remove", "--force", worktreePath],
      TIMEOUT.worktree,
      opts,
    ),
  );
}

export async function worktreePrune(
  repoDir: string,
  opts?: GitCallOptions,
): Promise<void> {
  await runGit(baseOpts(repoDir, ["worktree", "prune"], TIMEOUT.worktree, opts));
}

export async function deleteBranch(
  repoDir: string,
  branch: string,
  opts?: GitCallOptions,
): Promise<void> {
  await runGit(
    baseOpts(repoDir, ["branch", "-D", branch], TIMEOUT.default, opts),
  );
}

export async function revParse(
  repoDir: string,
  args: string[],
  opts?: GitCallOptions,
): Promise<string> {
  const result = await runGit(
    baseOpts(repoDir, ["rev-parse", ...args], TIMEOUT.resolve, opts),
  );
  return result.stdout.trim();
}

export async function diff(
  repoDir: string,
  args: string[] = [],
  opts?: GitCallOptions,
): Promise<string> {
  const result = await runGit(
    baseOpts(repoDir, ["diff", ...args], TIMEOUT.default, opts),
  );
  return result.stdout;
}

export function statusPorcelain(
  repoDir: string,
  pathspec?: string,
  opts?: GitCallOptions,
): string {
  const args = ["status", "--porcelain"];
  if (pathspec !== undefined) {
    args.push("--", pathspec);
  }
  return runGitSync(baseOpts(repoDir, args, TIMEOUT.default, opts)).stdout;
}

export async function checkRefFormat(
  branchName: string,
  opts?: GitCallOptions,
): Promise<boolean> {
  try {
    await runGit(
      baseOpts(undefined, ["check-ref-format", "--branch", branchName], TIMEOUT.resolve, opts),
    );
    return true;
  } catch {
    return false;
  }
}

export function revParseSync(
  cwd: string,
  args: string[],
  opts?: GitCallOptions,
): string {
  return runGitSync(baseOpts(cwd, ["rev-parse", ...args], TIMEOUT.resolve, opts)).stdout.trim();
}

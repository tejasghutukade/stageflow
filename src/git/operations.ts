import { GitError } from "./errors.js";
import { runGit, runGitSync, type RunGitOptions } from "./exec.js";

const TIMEOUT = {
  resolve: 30_000,
  worktree: 120_000,
  fetch: 300_000,
  clone: 900_000,
  default: 30_000,
} as const;

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

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

export const BARE_ORIGIN_FETCH_HEADS = "+refs/heads/*:refs/remotes/origin/*";
export const BARE_ORIGIN_FETCH_TAGS = "+refs/tags/*:refs/tags/*";

export async function configureBareOriginFetch(
  repoDir: string,
  opts?: GitCallOptions,
): Promise<void> {
  try {
    await runGit(
      baseOpts(repoDir, ["config", "--unset", "remote.origin.mirror"], TIMEOUT.default, opts),
    );
  } catch {
    // unset fails when the key is absent
  }
  try {
    await runGit(
      baseOpts(
        repoDir,
        ["config", "--unset-all", "remote.origin.fetch"],
        TIMEOUT.default,
        opts,
      ),
    );
  } catch {
    // unset-all fails when the key is absent
  }
  await runGit(
    baseOpts(
      repoDir,
      ["config", "--add", "remote.origin.fetch", BARE_ORIGIN_FETCH_HEADS],
      TIMEOUT.default,
      opts,
    ),
  );
  await runGit(
    baseOpts(
      repoDir,
      ["config", "--add", "remote.origin.fetch", BARE_ORIGIN_FETCH_TAGS],
      TIMEOUT.default,
      opts,
    ),
  );
}

export async function pruneNonStageflowLocalHeads(
  repoDir: string,
  opts?: GitCallOptions,
): Promise<void> {
  const listed = await runGit(
    baseOpts(
      repoDir,
      ["for-each-ref", "--format=%(refname)", "refs/heads/"],
      TIMEOUT.default,
      opts,
    ),
  );
  const refs = listed.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const ref of refs) {
    if (ref === "refs/heads/stageflow" || ref.startsWith("refs/heads/stageflow/")) {
      continue;
    }
    try {
      await runGit(
        baseOpts(repoDir, ["update-ref", "-d", ref], TIMEOUT.default, opts),
      );
    } catch {
      // best-effort prune under heal lock
    }
  }
}

export async function cloneBare(
  url: string,
  dest: string,
  opts?: GitCallOptions,
): Promise<void> {
  await runGit(baseOpts(undefined, ["clone", "--bare", url, dest], TIMEOUT.clone, opts));
  await configureBareOriginFetch(dest, opts);
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

async function revParseCommit(
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

async function tryRevParseCommit(
  repoDir: string,
  ref: string,
  opts?: GitCallOptions,
): Promise<string | null> {
  try {
    return await revParseCommit(repoDir, ref, opts);
  } catch (err) {
    if (err instanceof GitError && err.code === "ref_not_found") {
      return null;
    }
    throw err;
  }
}

export async function resolveRef(
  repoDir: string,
  ref: string,
  opts?: GitCallOptions,
): Promise<string> {
  if (FULL_SHA_RE.test(ref) || ref.startsWith("refs/")) {
    return revParseCommit(repoDir, ref, opts);
  }

  const candidates = [
    `refs/remotes/origin/${ref}`,
    `origin/${ref}`,
    `refs/tags/${ref}`,
  ];
  for (const candidate of candidates) {
    const sha = await tryRevParseCommit(repoDir, candidate, opts);
    if (sha !== null) return sha;
  }
  return revParseCommit(repoDir, candidates[0]!, opts);
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

export async function statusPorcelainZ(
  repoDir: string,
  opts?: GitCallOptions,
): Promise<string> {
  const result = await runGit(
    baseOpts(
      repoDir,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      TIMEOUT.default,
      opts,
    ),
  );
  return result.stdout;
}

export async function lsFilesOthersZ(
  repoDir: string,
  opts?: GitCallOptions,
): Promise<string> {
  const result = await runGit(
    baseOpts(
      repoDir,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      TIMEOUT.default,
      opts,
    ),
  );
  return result.stdout;
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

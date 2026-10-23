import { access, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { runGit } from "./gitCheckoutCapability.js";
import { sanitizeContainerNameSegment } from "./sandboxContainer.js";

/**
 * Auto-created worktrees live as siblings of the project root (not nested
 * inside it) — the same place `examples/ship-feature/README.md` already
 * tells operators to put a hand-made one, just automated.
 */
const WORKTREES_DIR_NAME = ".stageflow-worktrees";

export const sanitizeBranchForPath = sanitizeContainerNameSegment;

export function defaultBranchNameForTask(taskId: string): string {
  return `stageflow/${sanitizeBranchForPath(taskId)}`;
}

export function worktreePathFor(projectRoot: string, branch: string): string {
  return path.join(
    path.dirname(projectRoot),
    WORKTREES_DIR_NAME,
    sanitizeBranchForPath(branch),
  );
}

async function git(projectRoot: string, args: string[]): Promise<string> {
  const stdout = await runGit(projectRoot, args);
  return stdout.toString("utf8");
}

async function registeredWorktreePaths(projectRoot: string): Promise<Set<string>> {
  const stdout = await git(projectRoot, ["worktree", "list", "--porcelain"]);
  const paths = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = /^worktree (.+)$/.exec(line);
    if (match) paths.add(match[1]);
  }
  return paths;
}

async function branchExists(projectRoot: string, branch: string): Promise<boolean> {
  try {
    await git(projectRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

// A ref/branch value starting with `-` can get reinterpreted by git as a
// flag instead of a literal name (e.g. `-b --upload-pack=...`) — task YAML
// is operator-authored, not attacker input, but rejecting this outright is
// free and closes the class of mistake/footgun entirely.
function assertNotFlagLike(value: string, label: string): void {
  if (value.startsWith("-")) {
    throw new Error(`Invalid ${label} "${value}": must not start with "-"`);
  }
}

/**
 * Ensures a git worktree checked out to `branch` (creating the branch from
 * `base` if it doesn't exist yet) exists at a deterministic path derived
 * from the branch name, and returns that path.
 *
 * Deterministic (not per-run/random) on purpose: `resolveAndValidateCheckout`
 * is called twice per run start (runManager.ts, for the checkout lease key,
 * then pipelineRunner.ts, for the durable run record) — a random path would
 * create two worktrees for one run. A stable path also means rerunning the
 * same task/branch reuses the same worktree, matching the "leave it in
 * place" behavior an operator gets from making one by hand.
 */
export async function ensureWorktreeCheckout(params: {
  projectRoot: string;
  branch?: string;
  base?: string;
  taskId: string;
}): Promise<string> {
  // `git worktree list --porcelain` reports canonicalized paths (symlinks
  // resolved, e.g. macOS's /var -> /private/var) — realpath the project
  // root up front so every path this function builds or compares matches
  // what git itself reports, instead of drifting apart on a symlinked tmp
  // dir or similar.
  const projectRoot = await realpath(params.projectRoot);
  const branch = params.branch ?? defaultBranchNameForTask(params.taskId);
  assertNotFlagLike(branch, "checkout.branch");
  if (params.base !== undefined) assertNotFlagLike(params.base, "checkout.base");
  const targetPath = worktreePathFor(projectRoot, branch);

  const registered = await registeredWorktreePaths(projectRoot);
  if (registered.has(targetPath)) {
    if (await pathExists(targetPath)) {
      return targetPath;
    }
    // Registered but the directory is gone (e.g. deleted with `rm -rf`
    // instead of `git worktree remove`) — clear the stale registration so
    // `worktree add` below doesn't refuse to reuse the path.
    await git(projectRoot, ["worktree", "prune"]);
  } else if (await pathExists(targetPath)) {
    throw new Error(
      `Worktree path already exists but is not a registered git worktree: ${targetPath}. Remove it or use a different branch name.`,
    );
  }

  await mkdir(path.dirname(targetPath), { recursive: true });

  if (await branchExists(projectRoot, branch)) {
    await git(projectRoot, ["worktree", "add", targetPath, branch]);
  } else {
    await git(projectRoot, [
      "worktree",
      "add",
      targetPath,
      "-b",
      branch,
      params.base ?? "HEAD",
    ]);
  }

  // Two concurrent run-starts auto-creating the same branch/worktree can
  // race inside `git worktree add` itself — for the "branch already
  // exists" path this has been observed to exit 0 while leaving no
  // directory behind (the loser silently no-ops instead of erroring).
  // Turn that into a loud, unambiguous failure rather than handing back a
  // "successful" path that doesn't exist.
  if (!(await pathExists(targetPath))) {
    throw new Error(
      `git worktree add reported success but ${targetPath} does not exist — likely a concurrent worktree creation for the same branch ("${branch}"); retry.`,
    );
  }

  return targetPath;
}

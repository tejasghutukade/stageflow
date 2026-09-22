import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  bareCachePath,
  ensureBareCache,
} from "../git/cache.js";
import { GitError, type GitErrorCode } from "../git/errors.js";
import {
  catFileCommit,
  checkRefFormat,
  deleteBranch,
  resolveRef,
  revParse,
  worktreeAdd,
  worktreePrune,
  worktreeRemove,
} from "../git/operations.js";
import { ensureGlobalHome, globalStageflowHome } from "../project/globalHome.js";
import type { RunMeta } from "../runstore/port.js";
import type { TaskFile } from "../types/task.js";
import type { WorkspaceBinding } from "./workspaceBinding.js";

export type StartFailureCode =
  | "busy_capacity"
  | "busy_checkout"
  | "repository_auth_failed"
  | "repository_not_found"
  | "ref_not_found"
  | "repository_fetch_failed"
  | "worktree_create_failed"
  | "git_missing"
  | "insufficient_disk"
  | "disk_check_failed"
  | "pinned_sha_unavailable"
  | "invalid_run_branch"
  | "task.binding_conflict"
  | "task.repository_ref_required"
  | "task.ref_without_repository"
  | "task.repository_invalid"
  | "task.invalid_shape"
  | "task.load_error"
  | "start.token_rejected"
  | "shutting_down"
  | "autostart_disabled"
  | "claude_as_root";

export type MaterializedBinding = {
  runId: string;
  checkoutRoot?: string;
  repository?: string;
  ref?: string;
  resolvedSha?: string;
  runBranch?: string;
};

export type DerivedBindingKind = "repository" | "checkout" | "unbound";

const DEFAULT_BRANCH_TEMPLATE = "stageflow/run-<runId>";
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

export function derivedBindingKindFromMeta(meta: RunMeta): DerivedBindingKind {
  if (meta.repository != null && meta.repository !== "") {
    return "repository";
  }
  if (meta.checkout_root != null && meta.checkout_root !== "") {
    return "checkout";
  }
  return "unbound";
}

export function worktreePathForRun(runId: string): string {
  return path.join(globalStageflowHome(), "worktrees", runId);
}

function renderBranchTemplate(
  template: string,
  runId: string,
  taskId: string,
): string {
  return template.replaceAll("<runId>", runId).replaceAll("<taskId>", taskId);
}

export function resolveRunBranchTemplate(task: TaskFile): string {
  const fromTask = task.run_branch_template?.trim();
  if (fromTask) return fromTask;
  const fromEnv = process.env.STAGEFLOW_RUN_BRANCH_TEMPLATE?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_BRANCH_TEMPLATE;
}

export class StartLinkError extends Error {
  readonly code: StartFailureCode;
  readonly status: number;
  readonly stderr?: string;

  constructor(
    message: string,
    options: { code: StartFailureCode; status: number; stderr?: string },
  ) {
    super(message);
    this.name = "StartLinkError";
    this.code = options.code;
    this.status = options.status;
    this.stderr = options.stderr;
  }
}

function mapGitCode(
  code: GitErrorCode,
  phase: "fetch" | "resolve" | "worktree",
): { code: StartFailureCode; status: number } {
  switch (code) {
    case "auth_failed":
      return { code: "repository_auth_failed", status: 401 };
    case "repo_not_found":
      return { code: "repository_not_found", status: 404 };
    case "ref_not_found":
      return { code: "ref_not_found", status: 404 };
    case "network":
    case "timeout":
      return { code: "repository_fetch_failed", status: 502 };
    case "disk_full":
      return { code: "insufficient_disk", status: 507 };
    case "git_missing":
      return { code: "git_missing", status: 500 };
    default:
      if (phase === "worktree") {
        return { code: "worktree_create_failed", status: 500 };
      }
      if (phase === "resolve") {
        return { code: "ref_not_found", status: 404 };
      }
      return { code: "repository_fetch_failed", status: 502 };
  }
}

export function throwMappedGitError(
  err: unknown,
  phase: "fetch" | "resolve" | "worktree",
): never {
  if (err instanceof StartLinkError) throw err;
  if (err instanceof GitError) {
    const mapped = mapGitCode(err.code, phase);
    throw new StartLinkError(err.message, {
      code: mapped.code,
      status: mapped.status,
      stderr: err.stderr,
    });
  }
  throw err;
}

async function runRollbackThunks(
  thunks: Array<() => Promise<void>>,
): Promise<void> {
  for (const thunk of thunks) {
    try {
      await thunk();
    } catch (cleanupErr) {
      console.error(
        `repository link rollback failed: ${
          cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
        }`,
      );
    }
  }
}

export type MaterializeOptions = {
  runId: string;
  task: TaskFile;
  binding: WorkspaceBinding;
  checkoutRoot?: string;
  pinned?: { ref: string; resolvedSha: string };
};

export type ReclaimWorkspaceBindingOptions = {
  /** When true, remove the worktree but leave `run_branch` (SLIM must keep the branch). */
  keepRunBranch?: boolean;
};

export async function reclaimWorkspaceBinding(
  meta: RunMeta,
  options?: ReclaimWorkspaceBindingOptions,
): Promise<void> {
  if (derivedBindingKindFromMeta(meta) !== "repository") {
    return;
  }
  const cachePath = bareCachePath(meta.repository!);
  try {
    await worktreeRemove(cachePath, meta.checkout_root!);
  } catch {
  }
  try {
    await worktreePrune(cachePath);
  } catch {
  }
  if (options?.keepRunBranch) {
    return;
  }
  try {
    await deleteBranch(cachePath, meta.run_branch!);
  } catch {
  }
}

export async function materializeWorkspaceBinding(
  options: MaterializeOptions,
): Promise<{ materialized: MaterializedBinding; rollback: () => Promise<void> }> {
  const { runId, task, binding } = options;
  const rollbacks: Array<() => Promise<void>> = [];
  const rollback = async () => runRollbackThunks(rollbacks);

  if (binding.kind === "unbound") {
    return { materialized: { runId }, rollback };
  }

  if (binding.kind === "checkout") {
    const checkoutRoot = options.checkoutRoot;
    if (checkoutRoot === undefined) {
      throw new StartLinkError("Checkout path is required", {
        code: "worktree_create_failed",
        status: 500,
      });
    }
    let resolvedSha: string | undefined;
    if (options.pinned?.resolvedSha) {
      resolvedSha = options.pinned.resolvedSha;
    } else {
      try {
        const head = await revParse(checkoutRoot, ["HEAD"]);
        if (FULL_SHA_RE.test(head)) {
          resolvedSha = head;
        }
      } catch {
        // non-git path checkouts leave resolved_sha null (KD6/KD7)
      }
    }
    return {
      materialized: {
        runId,
        checkoutRoot,
        ...(resolvedSha !== undefined ? { resolvedSha } : {}),
      },
      rollback,
    };
  }

  const repository = binding.repository;
  const refToRecord = options.pinned?.ref ?? binding.ref;
  let resolvedSha: string;
  let cachePath: string;

  if (options.pinned) {
    cachePath = bareCachePath(repository);
    const present =
      existsSync(cachePath) &&
      (await catFileCommit(cachePath, options.pinned.resolvedSha));
    if (!present) {
      throw new StartLinkError(
        `Pinned SHA is not available in the local cache: ${options.pinned.resolvedSha}`,
        { code: "pinned_sha_unavailable", status: 404 },
      );
    }
    resolvedSha = options.pinned.resolvedSha;
  } else {
    try {
      const ensured = await ensureBareCache(repository, binding.ref);
      cachePath = ensured.cachePath;
    } catch (err) {
      throwMappedGitError(err, "fetch");
    }
    try {
      resolvedSha = await resolveRef(cachePath, binding.ref);
    } catch (err) {
      throwMappedGitError(err, "resolve");
    }
  }

  const template = resolveRunBranchTemplate(task);
  const runBranch = renderBranchTemplate(template, runId, task.id);
  const branchOk = await checkRefFormat(runBranch);
  if (!branchOk) {
    throw new StartLinkError(
      `Invalid run branch name from template: ${runBranch}`,
      { code: "invalid_run_branch", status: 400 },
    );
  }

  ensureGlobalHome();
  const checkoutRoot = worktreePathForRun(runId);
  mkdirSync(path.dirname(checkoutRoot), { recursive: true });

  try {
    await worktreeAdd(cachePath, {
      worktreePath: checkoutRoot,
      branch: runBranch,
      startPoint: resolvedSha,
    });
  } catch (err) {
    throwMappedGitError(err, "worktree");
  }

  rollbacks.push(async () => {
    try {
      await worktreeRemove(cachePath, checkoutRoot);
    } catch {
      // prune recovers admin state when the dir is already gone
    }
    await worktreePrune(cachePath);
  });
  rollbacks.push(async () => {
    await deleteBranch(cachePath, runBranch);
  });

  return {
    materialized: {
      runId,
      checkoutRoot,
      repository,
      ref: refToRecord,
      resolvedSha,
      runBranch,
    },
    rollback,
  };
}

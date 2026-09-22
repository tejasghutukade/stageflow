import { loadFailure, loadSuccess, type LoadOutcome } from "../config/loadOutcome.js";

export type WorkspaceBinding =
  | { kind: "repository"; repository: string; ref: string }
  | { kind: "checkout"; path: string }
  | { kind: "unbound" };

export type WorkspaceBindingInput = {
  repository?: string;
  ref?: string;
  checkout?: string;
};

export type ResolveWorkspaceBindingOptions = {
  checkoutOverride?: string;
};

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isGithubOwnerRepo(repository: string): boolean {
  return OWNER_REPO_RE.test(repository);
}

export function resolveWorkspaceBinding(
  task: WorkspaceBindingInput,
  options?: ResolveWorkspaceBindingOptions,
): LoadOutcome<WorkspaceBinding> {
  const repository = nonEmptyTrimmed(task.repository);
  const ref = nonEmptyTrimmed(task.ref);
  const checkoutPath = nonEmptyTrimmed(options?.checkoutOverride ?? task.checkout);
  const hasRepositoryField = repository !== undefined;

  if (hasRepositoryField && checkoutPath !== undefined) {
    return loadFailure([
      {
        code: "task.binding_conflict",
        message:
          "Task cannot declare both repository and checkout (exactly one workspace binding)",
        category: "task",
      },
    ]);
  }

  if (hasRepositoryField && ref === undefined) {
    return loadFailure([
      {
        code: "task.repository_ref_required",
        message: "Task repository requires a non-empty ref",
        category: "task",
      },
    ]);
  }

  if (ref !== undefined && repository === undefined) {
    return loadFailure([
      {
        code: "task.ref_without_repository",
        message: "Task ref requires repository",
        category: "task",
      },
    ]);
  }

  if (repository !== undefined && ref !== undefined) {
    if (!isGithubOwnerRepo(repository)) {
      return loadFailure([
        {
          code: "task.repository_invalid",
          message:
            "Task repository must be a GitHub owner/repo (e.g. acme/api); hosts and URLs are not accepted",
          category: "task",
        },
      ]);
    }
    return loadSuccess({ kind: "repository", repository, ref });
  }

  if (checkoutPath !== undefined) {
    return loadSuccess({ kind: "checkout", path: checkoutPath });
  }

  return loadSuccess({ kind: "unbound" });
}

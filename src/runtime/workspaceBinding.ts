import { loadFailure, loadSuccess, type LoadOutcome } from "../config/loadOutcome.js";
import type { CheckoutDescriptor } from "../types/task.js";

export type WorkspaceBinding =
  | { kind: "repository"; repository: string; ref: string }
  | { kind: "checkout"; path: string }
  | { kind: "unbound" };

export type WorkspaceBindingInput = {
  repository?: string;
  ref?: string;
  checkout?: CheckoutDescriptor;
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

function resolveCheckoutBinding(
  checkout?: CheckoutDescriptor,
  checkoutOverride?: string,
): string | { branch?: string; base?: string } | undefined {
  const override = nonEmptyTrimmed(checkoutOverride);
  if (override !== undefined) return override;
  if (checkout === undefined) return undefined;
  if (typeof checkout === "string") return nonEmptyTrimmed(checkout);
  if (typeof checkout === "object" && checkout !== null && !Array.isArray(checkout)) {
    return checkout;
  }
  return undefined;
}

export function resolveWorkspaceBinding(
  task: WorkspaceBindingInput,
  options?: ResolveWorkspaceBindingOptions,
): LoadOutcome<WorkspaceBinding> {
  const repository = nonEmptyTrimmed(task.repository);
  const ref = nonEmptyTrimmed(task.ref);
  const checkoutBinding = resolveCheckoutBinding(task.checkout, options?.checkoutOverride);
  const hasRepositoryField = repository !== undefined;

  if (hasRepositoryField && checkoutBinding !== undefined) {
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

  if (typeof checkoutBinding === "string") {
    return loadSuccess({ kind: "checkout", path: checkoutBinding });
  }
  if (typeof checkoutBinding === "object") {
    return loadSuccess({ kind: "checkout", path: "" });
  }

  return loadSuccess({ kind: "unbound" });
}

/**
 * A string points at a pre-made checkout directory (validated, never
 * created — today's behavior). An object asks Stageflow to create/reuse a
 * git worktree for `branch` (auto-named from the task id when omitted),
 * branching off `base` (default: HEAD) the first time it's created.
 */
export type CheckoutDescriptor = string | { branch?: string; base?: string };

export type TaskFile = {
  id: string;
  goal: string;
  context?: string;
  constraints?: string;
  checkout?: CheckoutDescriptor;
  input?: Record<string, unknown>;
};

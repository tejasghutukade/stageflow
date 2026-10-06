export type TaskGitIdentity = {
  name?: string;
  email?: string;
};

export type TaskFile = {
  id: string;
  goal: string;
  context?: string;
  constraints?: string;
  checkout?: string;
  repository?: string;
  ref?: string;
  run_branch_template?: string;
  git_identity?: TaskGitIdentity;
  input?: Record<string, unknown>;
};

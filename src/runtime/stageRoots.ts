import { access, constants, stat } from "node:fs/promises";
import path from "node:path";
import { isCursorModelRef } from "../agent/cursorProvider.js";
import { stageDir } from "../runstore/paths.js";
import type { RunMeta } from "../runstore/port.js";
import { attemptContext, noAttemptContext } from "./stageAttemptContext.js";
import type { StageAttemptContext } from "./stageAttemptContext.js";
import type { TaskFile, TaskGitIdentity } from "../types/task.js";
import { resolveCredentialBinding } from "./credentialBinding.js";

export type DerivedBindingKind = "repository" | "checkout" | "unbound";

export type StageRoots = {
  mode: "bound" | "unbound";
  cwd: string;
  runWorkspaceDir: string;
  checkoutRoot?: string;
  agentDir: string;
  attempt?: number;
  /** Durable Pi auth.json path for ModelRuntime.create({ authPath }). */
  authPath?: string;
};

export const STAGEFLOW_CHECKOUT = "STAGEFLOW_CHECKOUT";
export const STAGEFLOW_RUN_WORKSPACE = "STAGEFLOW_RUN_WORKSPACE";
export const STAGEFLOW_REPOSITORY = "STAGEFLOW_REPOSITORY";
export const STAGEFLOW_REF = "STAGEFLOW_REF";
export const STAGEFLOW_BASE_SHA = "STAGEFLOW_BASE_SHA";
export const STAGEFLOW_RUN_BRANCH = "STAGEFLOW_RUN_BRANCH";

export const REPOSITORY_ONLY_STAGEFLOW_VARS = [
  STAGEFLOW_REPOSITORY,
  STAGEFLOW_REF,
  STAGEFLOW_BASE_SHA,
  STAGEFLOW_RUN_BRANCH,
] as const;

export const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export type EffectiveGitIdentity = {
  name: string;
  email: string;
};

export type BuildStageBindingEnvInput = {
  kind: DerivedBindingKind;
  runWorkspaceDir: string;
  checkoutRoot?: string;
  repository?: string;
  ref?: string;
  resolvedSha?: string;
  runBranch?: string;
  gitIdentity: EffectiveGitIdentity;
  hostEnv?: NodeJS.ProcessEnv;
};

function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveEffectiveGitIdentity(
  hostEnv: NodeJS.ProcessEnv,
  taskIdentity?: TaskGitIdentity,
): EffectiveGitIdentity {
  const name =
    nonEmptyTrimmed(taskIdentity?.name) ??
    nonEmptyTrimmed(hostEnv.STAGEFLOW_GIT_AUTHOR_NAME) ??
    "Stageflow";
  const email =
    nonEmptyTrimmed(taskIdentity?.email) ??
    nonEmptyTrimmed(hostEnv.STAGEFLOW_GIT_AUTHOR_EMAIL) ??
    "stageflow@localhost";
  return { name, email };
}

export function buildStageBindingEnv(
  input: BuildStageBindingEnvInput,
): Record<string, string> {
  const hostEnv = input.hostEnv ?? {};
  const authorName = input.gitIdentity.name;
  const authorEmail = input.gitIdentity.email;
  const committerName =
    nonEmptyTrimmed(hostEnv.STAGEFLOW_GIT_COMMITTER_NAME) ?? authorName;
  const committerEmail =
    nonEmptyTrimmed(hostEnv.STAGEFLOW_GIT_COMMITTER_EMAIL) ?? authorEmail;

  const env: Record<string, string> = {
    [STAGEFLOW_RUN_WORKSPACE]: input.runWorkspaceDir,
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: committerName,
    GIT_COMMITTER_EMAIL: committerEmail,
  };

  if (input.checkoutRoot !== undefined && input.kind !== "unbound") {
    env[STAGEFLOW_CHECKOUT] = input.checkoutRoot;
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "safe.directory";
    env.GIT_CONFIG_VALUE_0 = input.checkoutRoot;
  }

  if (input.kind === "repository") {
    if (input.repository !== undefined) {
      env[STAGEFLOW_REPOSITORY] = input.repository;
    }
    if (input.ref !== undefined) {
      env[STAGEFLOW_REF] = input.ref;
    }
    if (input.resolvedSha !== undefined) {
      env[STAGEFLOW_BASE_SHA] = input.resolvedSha;
    }
    if (input.runBranch !== undefined) {
      env[STAGEFLOW_RUN_BRANCH] = input.runBranch;
    }
  }

  return env;
}

export function overlayStageBindingEnv(
  base: NodeJS.ProcessEnv,
  bindingEnv: Record<string, string>,
  kind: DerivedBindingKind,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...base, ...bindingEnv };
  if (kind !== "repository") {
    for (const key of REPOSITORY_ONLY_STAGEFLOW_VARS) {
      delete out[key];
    }
  }
  if (kind === "unbound" || !Object.hasOwn(bindingEnv, STAGEFLOW_CHECKOUT)) {
    delete out[STAGEFLOW_CHECKOUT];
  }
  if (!Object.hasOwn(bindingEnv, "GIT_CONFIG_COUNT")) {
    delete out.GIT_CONFIG_COUNT;
    delete out.GIT_CONFIG_KEY_0;
    delete out.GIT_CONFIG_VALUE_0;
  }
  return out;
}

export function bindingKindFromMeta(meta: RunMeta): DerivedBindingKind {
  if (meta.repository != null && meta.repository !== "") {
    return "repository";
  }
  if (meta.checkout_root != null && meta.checkout_root !== "") {
    return "checkout";
  }
  return "unbound";
}

export function stageBindingEnvFromRun(options: {
  meta: RunMeta;
  task: TaskFile;
  runWorkspaceDir: string;
  hostEnv?: NodeJS.ProcessEnv;
}): {
  kind: DerivedBindingKind;
  env: Record<string, string>;
  identity: EffectiveGitIdentity;
} {
  const hostEnv = options.hostEnv ?? process.env;
  const kind = bindingKindFromMeta(options.meta);
  const identity =
    options.meta.git_author_name !== undefined &&
    options.meta.git_author_email !== undefined
      ? {
          name: options.meta.git_author_name,
          email: options.meta.git_author_email,
        }
      : resolveEffectiveGitIdentity(hostEnv, options.task.git_identity);
  const env = buildStageBindingEnv({
    kind,
    runWorkspaceDir: options.runWorkspaceDir,
    ...(options.meta.checkout_root !== undefined
      ? { checkoutRoot: options.meta.checkout_root }
      : {}),
    ...(options.meta.repository !== undefined
      ? { repository: options.meta.repository }
      : {}),
    ...(options.meta.ref !== undefined ? { ref: options.meta.ref } : {}),
    ...(options.meta.resolved_sha !== undefined
      ? { resolvedSha: options.meta.resolved_sha }
      : {}),
    ...(options.meta.run_branch !== undefined
      ? { runBranch: options.meta.run_branch }
      : {}),
    gitIdentity: identity,
    hostEnv,
  });
  return { kind, env, identity };
}

export function withResolvedAuthPath(
  roots: StageRoots,
  factoryCwd: string,
): StageRoots {
  if (roots.authPath) return roots;
  const binding = resolveCredentialBinding(factoryCwd);
  return { ...roots, authPath: binding.authPath };
}

export function rootsForStageWorker(
  runWorkspaceDir: string,
  stageId: string,
  model: string,
  checkoutRoot?: string,
  attemptCtx?: StageAttemptContext,
): StageRoots {
  const roots = buildStageRoots(runWorkspaceDir, stageId, checkoutRoot, attemptCtx);
  if (!isCursorModelRef(model) || roots.mode === "bound") {
    return roots;
  }
  return {
    ...roots,
    cwd: stageDir(runWorkspaceDir, stageId),
  };
}

export function bindPiAgentDirEnv(agentDirPath: string): () => void {
  const prev = process.env[PI_CODING_AGENT_DIR_ENV];
  process.env[PI_CODING_AGENT_DIR_ENV] = agentDirPath;
  return () => {
    if (prev === undefined) {
      delete process.env[PI_CODING_AGENT_DIR_ENV];
    } else {
      process.env[PI_CODING_AGENT_DIR_ENV] = prev;
    }
  };
}

export function resolveCheckoutPath(declared: string, cwd: string): string {
  return path.resolve(cwd, declared);
}

export async function resolveAndValidateCheckout(
  task: TaskFile,
  override: string | undefined,
  factoryCwd: string,
): Promise<string | undefined> {
  const raw = override ?? task.checkout;
  if (raw === undefined) return undefined;
  if (raw.trim() === "") {
    throw new Error("Invalid checkout: path is empty or whitespace-only");
  }
  const absPath = resolveCheckoutPath(raw, factoryCwd);
  let st;
  try {
    st = await stat(absPath);
  } catch {
    throw new Error(`Checkout path does not exist: ${absPath}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`Checkout path is not a directory: ${absPath}`);
  }
  try {
    await access(absPath, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(
      `Checkout path is not readable/writable/searchable: ${absPath}`,
    );
  }
  return absPath;
}

export function buildStageRoots(
  runWorkspaceDir: string,
  stageId: string,
  checkoutRoot?: string,
  attemptCtx?: StageAttemptContext,
): StageRoots {
  const ctx = attemptCtx ?? noAttemptContext();
  const agentDirPath = ctx.agentDirPath(runWorkspaceDir, stageId);
  const attempt = ctx.attempt;
  if (checkoutRoot !== undefined) {
    return {
      mode: "bound",
      cwd: checkoutRoot,
      runWorkspaceDir,
      checkoutRoot,
      agentDir: agentDirPath,
      attempt,
    };
  }
  return {
    mode: "unbound",
    cwd: runWorkspaceDir,
    runWorkspaceDir,
    agentDir: agentDirPath,
    attempt,
  };
}

export function bindRunWorkspaceEnv(_runWorkspaceDir: string): () => void {
  return () => {};
}

export function resetBindRunWorkspaceEnvForTests(): void {
  delete process.env[STAGEFLOW_RUN_WORKSPACE];
}

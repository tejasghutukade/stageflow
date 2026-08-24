import { access, constants, stat } from "node:fs/promises";
import path from "node:path";
import { isCursorModelRef } from "../agent/cursorProvider.js";
import { stageDir } from "../runstore/paths.js";
import { attemptContext, noAttemptContext } from "./stageAttemptContext.js";
import type { StageAttemptContext } from "./stageAttemptContext.js";
import type { TaskFile } from "../types/task.js";
import { resolveCredentialBinding } from "./credentialBinding.js";

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

export const STAGEFLOW_RUN_WORKSPACE = "STAGEFLOW_RUN_WORKSPACE";

export const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

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

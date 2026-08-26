import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LoadedManifest } from "../types/stageflowManifest.js";
import type { LoadIssue } from "../config/loadOutcome.js";
import {
  loadStageflowManifestOutcome,
  manifestPathForProject,
} from "../config/loadStageflowManifest.js";
import { findProjectRoot } from "./findProjectRoot.js";
import { ensureGlobalHome } from "./globalHome.js";
import type { ProjectContext } from "./resolveProjectContext.js";

export type CatalogManifestStatus = "ok" | "missing" | "invalid" | "not_git";

export type StageflowContext = ProjectContext & {
  manifest: LoadedManifest | null;
  manifestStatus: CatalogManifestStatus;
  manifestIssues: LoadIssue[];
};

export function projectContextFromStageflow(ctx: StageflowContext): ProjectContext {
  return {
    invocationCwd: ctx.invocationCwd,
    projectRoot: ctx.projectRoot,
    globalHome: ctx.globalHome,
    isGitProject: ctx.isGitProject,
  };
}

export async function resolveStageflowContext(
  invocationCwd: string,
): Promise<StageflowContext> {
  const resolvedInvocation = path.resolve(invocationCwd);
  const gitRoot = findProjectRoot(resolvedInvocation);
  const globalHome = ensureGlobalHome();

  if (gitRoot === null) {
    return {
      invocationCwd: resolvedInvocation,
      projectRoot: os.homedir(),
      globalHome,
      isGitProject: false,
      manifest: null,
      manifestStatus: "not_git",
      manifestIssues: [],
    };
  }

  const manifestPath = manifestPathForProject(gitRoot);
  try {
    await access(manifestPath);
  } catch {
    return {
      invocationCwd: resolvedInvocation,
      projectRoot: gitRoot,
      globalHome,
      isGitProject: true,
      manifest: null,
      manifestStatus: "missing",
      manifestIssues: [],
    };
  }

  const outcome = await loadStageflowManifestOutcome(gitRoot);
  if (!outcome.ok) {
    return {
      invocationCwd: resolvedInvocation,
      projectRoot: gitRoot,
      globalHome,
      isGitProject: true,
      manifest: null,
      manifestStatus: "invalid",
      manifestIssues: outcome.issues,
    };
  }

  return {
    invocationCwd: resolvedInvocation,
    projectRoot: gitRoot,
    globalHome,
    isGitProject: true,
    manifest: outcome.value,
    manifestStatus: "ok",
    manifestIssues: [],
  };
}

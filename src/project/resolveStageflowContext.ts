import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LoadedManifest } from "../types/stageflowManifest.js";
import type { LoadIssue } from "../config/loadOutcome.js";
import {
  loadStageflowManifestOutcome,
  manifestPathForProject,
} from "../config/loadStageflowManifest.js";
import { findManifestRoot } from "./findManifestRoot.js";
import { findProjectRoot } from "./findProjectRoot.js";
import { globalStageflowHome } from "./globalHome.js";
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

/**
 * Project root resolution is keyed off the nearest `stageflow.yaml`, not git:
 * a manifest defines a project on its own, the same way a `package.json`
 * does for npm. Git is checked independently (`isGitProject`) for callers
 * that need it for execution (checkout/worktrees), not as a precondition
 * for finding or reading the catalog.
 */
export async function resolveStageflowContext(
  invocationCwd: string,
): Promise<StageflowContext> {
  const resolvedInvocation = path.resolve(invocationCwd);
  const globalHome = globalStageflowHome();

  const manifestRoot = findManifestRoot(resolvedInvocation);
  if (manifestRoot !== null) {
    const isGitProject = findProjectRoot(manifestRoot) !== null;
    const manifestPath = manifestPathForProject(manifestRoot);
    try {
      await access(manifestPath);
    } catch {
      return resolveWithoutManifest(resolvedInvocation, globalHome);
    }

    const outcome = await loadStageflowManifestOutcome(manifestRoot);
    if (!outcome.ok) {
      return {
        invocationCwd: resolvedInvocation,
        projectRoot: manifestRoot,
        globalHome,
        isGitProject,
        manifest: null,
        manifestStatus: "invalid",
        manifestIssues: outcome.issues,
      };
    }

    return {
      invocationCwd: resolvedInvocation,
      projectRoot: manifestRoot,
      globalHome,
      isGitProject,
      manifest: outcome.value,
      manifestStatus: "ok",
      manifestIssues: [],
    };
  }

  return resolveWithoutManifest(resolvedInvocation, globalHome);
}

function resolveWithoutManifest(
  resolvedInvocation: string,
  globalHome: string,
): StageflowContext {
  const gitRoot = findProjectRoot(resolvedInvocation);
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

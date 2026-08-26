import os from "node:os";
import path from "node:path";
import { findProjectRoot } from "./findProjectRoot.js";
import { ensureGlobalHome, globalStageflowHome } from "./globalHome.js";

export type ProjectContext = {
  invocationCwd: string;
  projectRoot: string;
  globalHome: string;
  isGitProject: boolean;
};

export function resolveProjectContext(invocationCwd: string): ProjectContext {
  const resolvedInvocation = path.resolve(invocationCwd);
  const gitRoot = findProjectRoot(resolvedInvocation);
  const globalHome = ensureGlobalHome();
  if (gitRoot !== null) {
    return {
      invocationCwd: resolvedInvocation,
      projectRoot: gitRoot,
      globalHome,
      isGitProject: true,
    };
  }
  return {
    invocationCwd: resolvedInvocation,
    projectRoot: os.homedir(),
    globalHome,
    isGitProject: false,
  };
}

export function legacyProjectContext(cwd: string): ProjectContext {
  const invocationCwd = path.resolve(cwd);
  return {
    invocationCwd,
    projectRoot: invocationCwd,
    globalHome: globalStageflowHome(),
    isGitProject: false,
  };
}

export function asProjectContext(input: ProjectContext | string): ProjectContext {
  if (typeof input !== "string") {
    return input;
  }
  return resolveProjectContext(input);
}

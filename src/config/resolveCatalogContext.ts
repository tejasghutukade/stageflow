import { access } from "node:fs/promises";
import { findProjectRoot } from "../project/findProjectRoot.js";
import type { LoadedManifest } from "../types/stageflowManifest.js";
import type { LoadIssue } from "./loadOutcome.js";
import {
  loadStageflowManifestOutcome,
  manifestPathForProject,
} from "./loadStageflowManifest.js";

export type CatalogManifestStatus = "ok" | "missing" | "invalid" | "not_git";

export type CatalogContext = {
  projectRoot: string | null;
  manifest: LoadedManifest | null;
  manifestStatus: CatalogManifestStatus;
  issues: LoadIssue[];
};

export async function resolveCatalogContext(
  invocationCwd: string,
): Promise<CatalogContext> {
  const projectRoot = findProjectRoot(invocationCwd);
  if (projectRoot === null) {
    return {
      projectRoot: null,
      manifest: null,
      manifestStatus: "not_git",
      issues: [],
    };
  }

  const manifestPath = manifestPathForProject(projectRoot);
  try {
    await access(manifestPath);
  } catch {
    return {
      projectRoot,
      manifest: null,
      manifestStatus: "missing",
      issues: [],
    };
  }

  const outcome = await loadStageflowManifestOutcome(projectRoot);
  if (!outcome.ok) {
    return {
      projectRoot,
      manifest: null,
      manifestStatus: "invalid",
      issues: outcome.issues,
    };
  }

  return {
    projectRoot,
    manifest: outcome.value,
    manifestStatus: "ok",
    issues: [],
  };
}

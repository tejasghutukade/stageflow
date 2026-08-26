import type { LoadedManifest } from "../types/stageflowManifest.js";
import type { LoadIssue } from "./loadOutcome.js";
import {
  resolveStageflowContext,
  type CatalogManifestStatus,
  type StageflowContext,
} from "../project/resolveStageflowContext.js";

export type { CatalogManifestStatus };

export type CatalogContext = {
  projectRoot: string | null;
  manifest: LoadedManifest | null;
  manifestStatus: CatalogManifestStatus;
  issues: LoadIssue[];
};

export function catalogContextFromStageflow(ctx: StageflowContext): CatalogContext {
  return {
    projectRoot: ctx.isGitProject ? ctx.projectRoot : null,
    manifest: ctx.manifest,
    manifestStatus: ctx.manifestStatus,
    issues: ctx.manifestIssues,
  };
}

/** @deprecated Prefer resolveStageflowContext */
export async function resolveCatalogContext(
  invocationCwd: string,
): Promise<CatalogContext> {
  return catalogContextFromStageflow(await resolveStageflowContext(invocationCwd));
}

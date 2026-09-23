import type { IncomingMessage, ServerResponse } from "node:http";
import { PACKAGE_VERSION } from "../package-meta.js";
import { globalStageflowHome } from "../project/globalHome.js";
import { redactHostConfig } from "../config/hostConfig.js";
import { resolveCatalogRoots } from "../config/resolveCatalogRoots.js";
import type { StageflowHostBootstrap } from "./bootstrap.js";
import { json } from "./createHttpHost.js";
import {
  livezBody,
  probeGitVersion,
  readSchemaHealth,
  runReadyzChecks,
} from "../diagnostics/checks.js";

export function handleLivez(
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  json(res, 200, livezBody());
}

export async function handleReadyz(
  _req: IncomingMessage,
  res: ServerResponse,
  boot: StageflowHostBootstrap,
): Promise<void> {
  if (boot.serveBlocked !== undefined) {
    json(res, 503, {
      ready: false,
      code: boot.serveBlocked.code,
      error: boot.serveBlocked.reason,
      checks: {
        store_openable: false,
        home_writable: false,
        migrations_complete: false,
        git_present: false,
      },
    });
    return;
  }
  const result = await runReadyzChecks({
    store: boot.store,
    homeDir: globalStageflowHome(),
  });
  json(res, result.ready ? 200 : 503, result);
}

export async function buildRichHealthPayload(
  boot: StageflowHostBootstrap,
): Promise<Record<string, unknown>> {
  const capacity = await boot.manager.getHealthWithDisk();
  const gitVersion = await probeGitVersion();
  const schema = readSchemaHealth(boot.store);
  const catalogRoots = await resolveCatalogRoots({
    store: boot.store,
    bootCwd: boot.cwd,
  });
  const payload: Record<string, unknown> = {
    ...capacity,
    capacity: {
      global: {
        activeRunIds: capacity.activeRunIds,
        activeCount: capacity.activeCount,
        maxConcurrent: capacity.maxConcurrent,
        slotsAvailable: capacity.slotsAvailable,
      },
      per_project: boot.manager.getPerProjectCapacity(),
    },
    version: PACKAGE_VERSION,
    build_sha: process.env.STAGEFLOW_BUILD_SHA ?? null,
    stageflow_home: globalStageflowHome(),
    schema,
    git_version: gitVersion ?? null,
    catalog_roots: catalogRoots.map((r) => ({
      project_root: r.project_root,
      kind: r.kind,
      read_only: r.read_only,
    })),
    providers: boot.providerBoot
      ? {
          configured: boot.providerBoot.configured,
          failures: boot.providerBoot.failures,
        }
      : { configured: [], failures: [] },
  };
  if (boot.hostConfig) {
    payload.config = redactHostConfig(boot.hostConfig);
  }
  if (boot.a2a?.status) {
    payload.a2a = boot.a2a.status;
  }
  return payload;
}

export async function handleApiHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  boot: StageflowHostBootstrap,
): Promise<void> {
  json(res, 200, await buildRichHealthPayload(boot));
}

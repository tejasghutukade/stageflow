import type { IncomingMessage, ServerResponse } from "node:http";
import type { BootProviderResult } from "../agent/bootProviderConfig.js";
import {
  getAuthStatus,
  type ProviderAuthContext,
} from "../agent/providerAuth.js";
import { PACKAGE_VERSION, BUILD_SHA } from "../package-meta.js";
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
import { buildEgressHealth } from "../net/proxy.js";
import { toolchainHealthMap } from "../preflight/toolchain.js";

function bootProvidersSnapshot(
  providerBoot: BootProviderResult | undefined,
): { configured: string[]; failures: BootProviderResult["failures"] } {
  return providerBoot
    ? {
        configured: providerBoot.configured,
        failures: providerBoot.failures,
      }
    : { configured: [], failures: [] };
}

async function providersLiveSummary(
  cwd: string,
  authCtx: ProviderAuthContext | undefined,
): Promise<{ configured: string[]; note: string }> {
  const note =
    "Live auth inspect — prefer list_providers / sf providers status. boot_providers is Host boot env only and may be empty when CLI credentials are configured.";
  if (authCtx === undefined) {
    return { configured: [], note };
  }
  try {
    const status = await getAuthStatus(cwd, undefined, authCtx);
    const rows = Array.isArray(status) ? status : [status];
    return {
      configured: rows.filter((r) => r.configured).map((r) => r.providerId),
      note,
    };
  } catch {
    return { configured: [], note };
  }
}

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
  if (boot.store === undefined) {
    json(res, 503, {
      ready: false,
      error: "store unavailable",
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
  if (boot.manager === undefined || boot.store === undefined) {
    throw new Error("buildRichHealthPayload requires store and manager");
  }
  const capacity = await boot.manager.getHealthWithDisk();
  const gitVersion = await probeGitVersion();
  const schema = readSchemaHealth(boot.store);
  const catalogRoots = await resolveCatalogRoots({
    store: boot.store,
    bootCwd: boot.cwd,
  });
  const boot_providers = bootProvidersSnapshot(boot.providerBoot);
  const providers_live = await providersLiveSummary(
    boot.cwd,
    boot.providerAuthContext,
  );
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
    build_sha: BUILD_SHA,
    stageflow_home: globalStageflowHome(),
    schema,
    git_version: gitVersion ?? null,
    toolchain: toolchainHealthMap(),
    store_filesystem: boot.storeFilesystem ?? null,
    egress: buildEgressHealth(),
    catalog_roots: catalogRoots.map((r) => ({
      project_root: r.project_root,
      kind: r.kind,
      read_only: r.read_only,
    })),
    boot_providers,
    providers_live,
    providers: boot_providers,
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

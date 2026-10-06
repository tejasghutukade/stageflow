import {
  defaultContext,
  detectPiHome,
  getAuthStatus,
  listProviders,
  ProviderAuthError,
  type PiHomeDetectResult,
  type ProviderAuthContext,
  type ProviderAuthStatus,
  type ProviderSummary,
  type ProvidersListResult,
} from "./providerAuth.js";

export type ProviderReadinessRow = ProviderSummary & {
  configured: boolean;
  authKind?: ProviderAuthStatus["authKind"];
  source?: string;
};

export type ProviderReadinessInspect = {
  authShell: ProvidersListResult["authShell"];
  via: ProvidersListResult["via"];
  detect: PiHomeDetectResult;
  providers: ProviderReadinessRow[];
};

function statusList(
  statuses: ProviderAuthStatus | ProviderAuthStatus[],
): ProviderAuthStatus[] {
  return Array.isArray(statuses) ? statuses : [statuses];
}

export async function inspectProviderReadiness(
  cwd: string,
  ctx: ProviderAuthContext = defaultContext,
): Promise<ProviderReadinessInspect> {
  const listed = await listProviders(cwd, ctx);
  const statuses = statusList(await getAuthStatus(cwd, undefined, ctx));
  const statusById = new Map(
    statuses.map((status) => [status.providerId, status]),
  );
  const detect = detectPiHome(cwd);
  return {
    authShell: listed.authShell,
    via: listed.via,
    detect,
    providers: listed.providers.map((provider) => {
      const status = statusById.get(provider.id);
      return {
        ...provider,
        configured: status?.configured ?? false,
        ...(status?.authKind !== undefined
          ? { authKind: status.authKind }
          : {}),
        ...(status?.source !== undefined ? { source: status.source } : {}),
      };
    }),
  };
}

export function mapProviderAuthError(err: unknown): {
  status: number;
  body: { error: string };
} {
  if (err instanceof ProviderAuthError) {
    return { status: err.status, body: { error: err.message } };
  }
  return {
    status: 500,
    body: { error: "Provider auth operation failed" },
  };
}

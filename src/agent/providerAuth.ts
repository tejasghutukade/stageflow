import {
  CredentialSynchronizationError,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Provider,
} from "@earendil-works/pi-ai";
import {
  isUsableAuthFile,
  parseCredentialSource,
  piHomeAuthPath,
  readCredentialSourceFromContext,
  resolveCredentialBinding,
  writeCredentialSourceToContext,
} from "../runtime/credentialBinding.js";
import {
  readPersistedCredentialSourceFromContext,
} from "../runtime/settingsFile.js";
import type { CredentialSource } from "../runtime/settingsFile.js";
import { resolveProjectContext } from "../project/resolveProjectContext.js";

export type ProviderSummary = {
  id: string;
  name: string;
  supportsApiKey: boolean;
  supportsOauth: boolean;
  oauthLabel?: string;
};

export type LoginCapableProvider = {
  id: string;
  name: string;
  apiKeyLogin: boolean;
  oauth: boolean;
  oauthLabel?: string;
};

export type ProviderAuthStatus = {
  providerId: string;
  configured: boolean;
  authKind?: "api_key" | "oauth" | "none";
  source?: string;
};

export type ProvidersListResult = {
  authShell: "pi";
  via: "pi";
  providers: ProviderSummary[];
};

export type PiHomeDetectResult = {
  piHomeUsable: boolean;
  credentialSource?: CredentialSource;
  provisional: boolean;
  source: CredentialSource;
};

export type ProviderAuthRuntime = {
  getProviders(): readonly Provider[];
  getProvider(providerId: string): Provider | undefined;
  getProviderAuthStatus(providerId: string): {
    configured: boolean;
    source?: string;
    label?: string;
  };
  listCredentials(): Promise<
    readonly { providerId: string; type: "api_key" | "oauth" }[]
  >;
  checkAuth(
    providerId: string,
  ): Promise<{ source?: string; type: "api_key" | "oauth" } | undefined>;
  login(
    providerId: string,
    type: "api_key" | "oauth",
    interaction: AuthInteraction,
  ): Promise<unknown>;
  logout(providerId: string): Promise<void>;
};

export type CreateProviderAuthRuntime = (
  authPath: string,
) => Promise<ProviderAuthRuntime>;

export type MutationLock = {
  withMutationLock<T>(fn: () => Promise<T>): Promise<T>;
};

export type ProviderAuthContext = {
  createRuntime: CreateProviderAuthRuntime;
  lock: MutationLock;
};

export function makeMutationLock(): MutationLock {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(fn, fn);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

export class ProviderAuthError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProviderAuthError";
    this.status = status;
  }
}

const defaultCreateRuntime: CreateProviderAuthRuntime = async (authPath) =>
  ModelRuntime.create({ authPath, refreshOnCreate: false });

export const defaultContext: ProviderAuthContext = {
  createRuntime: defaultCreateRuntime,
  lock: makeMutationLock(),
};

export async function openRuntime(
  cwd: string,
  ctx: ProviderAuthContext = defaultContext,
): Promise<ProviderAuthRuntime> {
  const binding = resolveCredentialBinding(cwd);
  return ctx.createRuntime(binding.authPath);
}

export function isLoginCapable(provider: {
  auth?: { oauth?: unknown; apiKey?: { login?: unknown } };
}): boolean {
  return (
    provider.auth?.oauth != null || provider.auth?.apiKey?.login != null
  );
}

export function listLoginCapableProviders(
  runtime: Pick<ProviderAuthRuntime, "getProviders">,
): LoginCapableProvider[] {
  return runtime
    .getProviders()
    .filter(isLoginCapable)
    .map((provider) => {
      const apiKeyLogin = provider.auth?.apiKey?.login != null;
      const oauth = provider.auth?.oauth != null;
      const oauthName =
        oauth && provider.auth?.oauth && "name" in provider.auth.oauth
          ? provider.auth.oauth.name
          : undefined;
      return {
        id: provider.id,
        name: provider.name,
        apiKeyLogin,
        oauth,
        ...(typeof oauthName === "string" && oauthName.length > 0
          ? { oauthLabel: oauthName }
          : {}),
      };
    });
}

function mapProvider(provider: Provider): ProviderSummary {
  const supportsApiKey = provider.auth.apiKey?.login != null;
  const supportsOauth = provider.auth.oauth !== undefined;
  const oauthLabel =
    supportsOauth && typeof provider.auth.oauth?.name === "string"
      ? provider.auth.oauth.name
      : undefined;
  return {
    id: provider.id,
    name: provider.name,
    supportsApiKey,
    supportsOauth,
    ...(oauthLabel !== undefined && oauthLabel.length > 0
      ? { oauthLabel }
      : {}),
  };
}

function safeStatus(
  providerId: string,
  status: { configured: boolean; source?: string; label?: string },
  authKind?: "api_key" | "oauth" | "none",
): ProviderAuthStatus {
  const out: ProviderAuthStatus = {
    providerId,
    configured: status.configured,
  };
  if (authKind !== undefined) {
    out.authKind = authKind;
  }
  if (typeof status.source === "string" && status.source.length > 0) {
    out.source = status.source;
  } else if (typeof status.label === "string" && status.label.length > 0) {
    out.source = status.label;
  }
  return out;
}

export async function statusForProvider(
  runtime: ProviderAuthRuntime,
  providerId: string,
): Promise<ProviderAuthStatus> {
  const status = runtime.getProviderAuthStatus(providerId);
  const creds = await runtime.listCredentials();
  const stored = creds.find((c) => c.providerId === providerId);
  let authKind: "api_key" | "oauth" | "none" = "none";
  if (stored) {
    authKind = stored.type;
  } else {
    try {
      const checked = await runtime.checkAuth(providerId);
      if (checked?.type === "api_key" || checked?.type === "oauth") {
        authKind = checked.type;
      }
    } catch {
      // ignore check failures for status DTO
    }
  }
  const configured = Boolean(stored) || status.configured;
  const mapped = safeStatus(
    providerId,
    {
      configured,
      source: stored ? (status.source ?? "stored") : status.source,
      label: status.label,
    },
    authKind,
  );
  return mapped;
}

export async function listProviders(
  cwd: string,
  ctx: ProviderAuthContext = defaultContext,
): Promise<ProvidersListResult> {
  const runtime = await openRuntime(cwd, ctx);
  return {
    authShell: "pi",
    via: "pi",
    providers: runtime
      .getProviders()
      .filter(isLoginCapable)
      .map(mapProvider),
  };
}

export async function getAuthStatus(
  cwd: string,
  providerId?: string,
  ctx: ProviderAuthContext = defaultContext,
): Promise<ProviderAuthStatus | ProviderAuthStatus[]> {
  const runtime = await openRuntime(cwd, ctx);
  if (providerId !== undefined) {
    if (!runtime.getProvider(providerId)) {
      throw new ProviderAuthError("Provider not found", 404);
    }
    return statusForProvider(runtime, providerId);
  }
  const providers = runtime.getProviders();
  const out: ProviderAuthStatus[] = [];
  for (const provider of providers) {
    out.push(await statusForProvider(runtime, provider.id));
  }
  return out;
}

function apiKeyInteraction(apiKey: string): AuthInteraction {
  return {
    async prompt(prompt: AuthPrompt): Promise<string> {
      if (prompt.type === "secret") {
        return apiKey;
      }
      throw new ProviderAuthError(
        "Unexpected auth prompt for api_key login",
        400,
      );
    },
    notify(): void {},
  };
}

function mapLoginError(err: unknown, providerId: string): never {
  if (err instanceof ProviderAuthError) {
    throw err;
  }
  if (err instanceof CredentialSynchronizationError) {
    throw new ProviderAuthError(
      `Credential sync failed for provider ${providerId}`,
      502,
    );
  }
  throw new ProviderAuthError("Provider login failed", 500);
}

export async function loginWithApiKey(
  cwd: string,
  providerId: string,
  apiKey: string,
  ctx: ProviderAuthContext = defaultContext,
): Promise<ProviderAuthStatus> {
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw new ProviderAuthError("apiKey is required", 400);
  }
  return ctx.lock.withMutationLock(async () => {
    const runtime = await openRuntime(cwd, ctx);
    const provider = runtime.getProvider(providerId);
    if (!provider) {
      throw new ProviderAuthError("Provider not found", 404);
    }
    if (typeof provider.auth.apiKey?.login !== "function") {
      throw new ProviderAuthError(
        "Provider does not support api_key login",
        400,
      );
    }
    try {
      await runtime.login(providerId, "api_key", apiKeyInteraction(apiKey));
    } catch (err) {
      mapLoginError(err, providerId);
    }
    return statusForProvider(runtime, providerId);
  });
}

export type OauthLoginResult = {
  provider: ProviderAuthStatus;
  warning?: string;
};

export async function loginWithOauth(
  cwd: string,
  providerId: string,
  interaction: AuthInteraction,
  ctx: ProviderAuthContext = defaultContext,
): Promise<OauthLoginResult> {
  return ctx.lock.withMutationLock(async () => {
    const runtime = await openRuntime(cwd, ctx);
    const provider = runtime.getProvider(providerId);
    if (!provider) {
      throw new ProviderAuthError("Provider not found", 404);
    }
    if (provider.auth.oauth === undefined) {
      throw new ProviderAuthError("Provider does not support oauth login", 400);
    }
    try {
      await runtime.login(providerId, "oauth", interaction);
      return { provider: await statusForProvider(runtime, providerId) };
    } catch (err) {
      if (err instanceof CredentialSynchronizationError) {
        let status: ProviderAuthStatus;
        try {
          status = await statusForProvider(runtime, providerId);
        } catch {
          status = {
            providerId,
            configured: true,
            authKind: "oauth",
          };
        }
        return {
          provider: status.configured
            ? status
            : {
                ...status,
                configured: true,
                authKind: status.authKind ?? "oauth",
              },
          warning:
            "Connected, but model catalog sync failed. Credentials were saved — you can retry later without disconnecting.",
        };
      }
      if (interaction.signal?.aborted) {
        throw new ProviderAuthError("Login cancelled", 400);
      }
      if (err instanceof Error && /cancel/i.test(err.message)) {
        throw new ProviderAuthError("Login cancelled", 400);
      }
      mapLoginError(err, providerId);
    }
  });
}

export async function logoutProvider(
  cwd: string,
  providerId: string,
  ctx: ProviderAuthContext = defaultContext,
): Promise<ProviderAuthStatus> {
  return ctx.lock.withMutationLock(async () => {
    const runtime = await openRuntime(cwd, ctx);
    if (!runtime.getProvider(providerId)) {
      throw new ProviderAuthError("Provider not found", 404);
    }
    try {
      await runtime.logout(providerId);
    } catch (err) {
      if (err instanceof CredentialSynchronizationError) {
        throw new ProviderAuthError(
          `Credential sync failed for provider ${providerId}`,
          502,
        );
      }
      throw new ProviderAuthError("Provider logout failed", 500);
    }
    return statusForProvider(runtime, providerId);
  });
}

export function detectPiHome(cwd: string): PiHomeDetectResult {
  const projectCtx = resolveProjectContext(cwd);
  const binding = resolveCredentialBinding(projectCtx);
  const persisted = readPersistedCredentialSourceFromContext(projectCtx);
  return {
    piHomeUsable: isUsableAuthFile(piHomeAuthPath()),
    ...(persisted !== undefined ? { credentialSource: persisted } : {}),
    provisional: binding.provisional,
    source: binding.source,
  };
}

export function getCredentialSourceSettings(cwd: string): {
  credentialSource?: CredentialSource;
  binding: { source: CredentialSource; provisional: boolean };
} {
  const projectCtx = resolveProjectContext(cwd);
  const persisted = readPersistedCredentialSourceFromContext(projectCtx);
  const binding = resolveCredentialBinding(projectCtx);
  return {
    ...(persisted !== undefined ? { credentialSource: persisted } : {}),
    binding: {
      source: binding.source,
      provisional: binding.provisional,
    },
  };
}

export function setCredentialSource(
  cwd: string,
  credentialSource: unknown,
): {
  credentialSource: CredentialSource;
  binding: { source: CredentialSource; provisional: boolean };
} {
  const parsed = parseCredentialSource(credentialSource);
  if (parsed === undefined) {
    throw new ProviderAuthError(
      'credentialSource must be "pi_home" or "sf_owned"',
      400,
    );
  }
  const projectCtx = resolveProjectContext(cwd);
  writeCredentialSourceToContext(projectCtx, parsed);
  const binding = resolveCredentialBinding(projectCtx);
  return {
    credentialSource: parsed,
    binding: {
      source: binding.source,
      provisional: binding.provisional,
    },
  };
}

import {
  loginWithApiKey,
  type ProviderAuthContext,
} from "./providerAuth.js";
import {
  readSecretFromEnvOrFile,
  SecretFromEnvError,
} from "../config/secretFromEnvOrFile.js";

const PROVIDER_KEY_RE = /^STAGEFLOW_PROVIDER_([A-Za-z0-9_]+)_API_KEY$/;
const PROVIDER_FILE_RE = /^STAGEFLOW_PROVIDER_([A-Za-z0-9_]+)_API_KEY_FILE$/;

export type BootProviderResult = {
  configured: string[];
  failures: Array<{ providerId: string; code: string; message: string }>;
};

export type BootProviderOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  requireProviders?: string[];
  authContext?: ProviderAuthContext;
  logError?: (message: string) => void;
};

type DiscoveredProvider = {
  /** Raw ID segment as it appeared in the env key (casing preserved). */
  envId: string;
  /** Provider id passed to login (lowercased). */
  providerId: string;
};

function discoverProviders(env: NodeJS.ProcessEnv): DiscoveredProvider[] {
  const byLower = new Map<string, DiscoveredProvider>();
  for (const key of Object.keys(env)) {
    let envId: string | undefined;
    const plain = key.match(PROVIDER_KEY_RE);
    if (plain) envId = plain[1];
    else {
      const file = key.match(PROVIDER_FILE_RE);
      if (file) envId = file[1];
    }
    if (envId === undefined) continue;
    const providerId = envId.toLowerCase().replace(/_/g, "-");
    if (!byLower.has(providerId)) {
      byLower.set(providerId, { envId, providerId });
    }
  }
  return [...byLower.values()].sort((a, b) =>
    a.providerId.localeCompare(b.providerId),
  );
}

/**
 * Configure providers from STAGEFLOW_PROVIDER_<ID>_API_KEY / _FILE at Host boot.
 * Soft-fails unreadable/rejected keys by default; requireProviders makes missing ids fatal.
 */
export async function bootProviderConfig(
  options: BootProviderOptions,
): Promise<BootProviderResult> {
  const env = options.env ?? process.env;
  const logError =
    options.logError ?? ((message: string) => console.error(message));
  const configured: string[] = [];
  const failures: BootProviderResult["failures"] = [];

  for (const { envId, providerId } of discoverProviders(env)) {
    const envName = `STAGEFLOW_PROVIDER_${envId}_API_KEY`;
    let secret: string | undefined;
    try {
      secret = readSecretFromEnvOrFile(env, envName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (
        err instanceof SecretFromEnvError &&
        message.includes("not both")
      ) {
        throw err;
      }
      const code =
        err instanceof SecretFromEnvError ? err.code : "config_invalid";
      failures.push({ providerId, code, message });
      logError(`stageflow: provider ${providerId} boot failed: ${message}`);
      continue;
    }
    if (secret === undefined) continue;
    try {
      await loginWithApiKey(
        options.cwd,
        providerId,
        secret,
        options.authContext,
      );
      configured.push(providerId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({
        providerId,
        code: "provider_not_configured",
        message,
      });
      logError(`stageflow: provider ${providerId} boot failed: ${message}`);
    }
  }

  const required = (options.requireProviders ?? []).map((id) =>
    id.toLowerCase(),
  );
  const missing = required.filter((id) => !configured.includes(id));
  if (missing.length > 0) {
    throw new Error(
      `STAGEFLOW_REQUIRE_PROVIDERS: missing configured providers: ${missing.join(", ")}`,
    );
  }

  return { configured, failures };
}

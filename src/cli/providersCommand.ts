import type { AuthInteraction } from "@earendil-works/pi-ai";
import {
  defaultContext,
  detectPiHome,
  getAuthStatus,
  getCredentialSourceSettings,
  listProviders,
  loginWithApiKey,
  loginWithOauth,
  logoutProvider,
  ProviderAuthError,
  setCredentialSource,
  type ProviderAuthContext,
  type ProviderAuthStatus,
  type ProviderSummary,
} from "../agent/providerAuth.js";
import { createTerminalAuthInteraction } from "./terminalAuthInteraction.js";
import { promptSecret, readApiKeyFromEnv } from "./terminalSecret.js";

export const PROVIDERS_USAGE = `Usage:
  sf providers list
  sf providers status [--provider <id>]
  sf providers detect
  sf providers source [get | set <pi_home|sf_owned>]
  sf providers login <providerId> [--type api_key|oauth] [--api-key-env <VAR>]
  sf providers logout <providerId>`;

export type ProvidersCommandIo = {
  log: (line: string) => void;
  error: (line: string) => void;
  env: NodeJS.ProcessEnv;
  readSecret: (message: string) => Promise<string>;
  createAuthInteraction: (signal: AbortSignal) => AuthInteraction;
};

const defaultIo: ProvidersCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  env: process.env,
  readSecret: promptSecret,
  createAuthInteraction: (signal) =>
    createTerminalAuthInteraction({ signal }),
};

function scrub(message: string, secrets: string[]): string {
  let out = message;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

function formatStatus(status: ProviderAuthStatus): string {
  const parts = [
    status.providerId,
    status.configured ? "configured" : "disconnected",
  ];
  if (status.authKind !== undefined) parts.push(`kind=${status.authKind}`);
  if (status.source !== undefined) parts.push(`source=${status.source}`);
  return parts.join("\t");
}

function formatProvider(p: ProviderSummary): string {
  const caps: string[] = [];
  if (p.supportsApiKey) caps.push("api_key");
  if (p.supportsOauth) caps.push("oauth");
  const label =
    p.oauthLabel !== undefined && p.oauthLabel.length > 0
      ? `\t${p.oauthLabel}`
      : "";
  return `${p.id}\t${p.name}\t${caps.join(",") || "none"}${label}`;
}

type ParsedProviders = {
  subcommand?: string;
  help: boolean;
  providerFlag?: string;
  type?: "api_key" | "oauth";
  apiKeyEnv?: string;
  positionals: string[];
};

function parseProvidersArgs(args: string[]): ParsedProviders {
  if (args.length === 0) {
    return { help: false, positionals: [] };
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return { help: true, positionals: [] };
  }
  const subcommand = args[0];
  let providerFlag: string | undefined;
  let type: "api_key" | "oauth" | undefined;
  let apiKeyEnv: string | undefined;
  let help = false;
  const positionals: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--provider") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --provider");
      }
      providerFlag = value;
    } else if (arg === "--type") {
      const value = args[++i];
      if (value !== "api_key" && value !== "oauth") {
        throw new Error("--type must be api_key or oauth");
      }
      type = value;
    } else if (arg === "--api-key-env") {
      const value = args[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("Missing value for --api-key-env");
      }
      apiKeyEnv = value;
    } else if (arg === "--api-key") {
      throw new Error(
        "Raw --api-key is not supported; use a prompt or --api-key-env <VAR>",
      );
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return { subcommand, help, providerFlag, type, apiKeyEnv, positionals };
}

function resolveLoginType(
  provider: ProviderSummary,
  type: "api_key" | "oauth" | undefined,
): "api_key" | "oauth" {
  if (provider.supportsApiKey && provider.supportsOauth) {
    if (type === undefined) {
      throw new Error(
        "Provider supports both api_key and oauth; pass --type api_key|oauth",
      );
    }
    return type;
  }
  if (type === "api_key") {
    if (!provider.supportsApiKey) {
      throw new Error("Provider does not support api_key login");
    }
    return "api_key";
  }
  if (type === "oauth") {
    if (!provider.supportsOauth) {
      throw new Error("Provider does not support oauth login");
    }
    return "oauth";
  }
  if (provider.supportsOauth) return "oauth";
  if (provider.supportsApiKey) return "api_key";
  throw new Error("Provider does not support interactive login");
}

export async function runProvidersCommand(
  args: string[],
  cwd: string,
  io: Partial<ProvidersCommandIo> = {},
  ctx: ProviderAuthContext = defaultContext,
): Promise<number> {
  const out: ProvidersCommandIo = { ...defaultIo, ...io };
  let secrets: string[] = [];

  try {
    const parsed = parseProvidersArgs(args);
    if (parsed.help || !parsed.subcommand) {
      out.error(PROVIDERS_USAGE);
      return parsed.help ? 0 : 1;
    }

    switch (parsed.subcommand) {
      case "list": {
        const listed = await listProviders(cwd, ctx);
        for (const provider of listed.providers) {
          out.log(formatProvider(provider));
        }
        return 0;
      }
      case "status": {
        try {
          const status = await getAuthStatus(cwd, parsed.providerFlag, ctx);
          if (Array.isArray(status)) {
            for (const row of status) out.log(formatStatus(row));
          } else {
            out.log(formatStatus(status));
          }
          return 0;
        } catch (err) {
          if (err instanceof ProviderAuthError && err.status === 404) {
            out.error("Provider not found");
            return 1;
          }
          throw err;
        }
      }
      case "detect": {
        const detected = detectPiHome(cwd);
        const sourceLine =
          detected.credentialSource !== undefined
            ? `credentialSource=${detected.credentialSource}`
            : "credentialSource=(unset)";
        out.log(
          [
            `piHomeUsable=${detected.piHomeUsable}`,
            sourceLine,
            `provisional=${detected.provisional}`,
            `bindingSource=${detected.source}`,
          ].join("\t"),
        );
        return 0;
      }
      case "source": {
        const action = parsed.positionals[0] ?? "get";
        if (action === "get") {
          const settings = getCredentialSourceSettings(cwd);
          if (settings.credentialSource !== undefined) {
            out.log(settings.credentialSource);
          } else {
            out.log(
              `(unset; binding=${settings.binding.source}${settings.binding.provisional ? ", provisional" : ""})`,
            );
          }
          return 0;
        }
        if (action === "set") {
          const value = parsed.positionals[1];
          if (value !== "pi_home" && value !== "sf_owned") {
            out.error('source set requires pi_home or sf_owned');
            out.error(PROVIDERS_USAGE);
            return 1;
          }
          const result = setCredentialSource(cwd, value);
          out.log(result.credentialSource);
          return 0;
        }
        out.error(`Unknown source action: ${action}`);
        out.error(PROVIDERS_USAGE);
        return 1;
      }
      case "login": {
        const providerId = parsed.positionals[0];
        if (!providerId) {
          out.error("Missing providerId");
          out.error(PROVIDERS_USAGE);
          return 1;
        }
        const listed = await listProviders(cwd, ctx);
        const provider = listed.providers.find((p) => p.id === providerId);
        if (!provider) {
          out.error("Provider not found");
          return 1;
        }
        const loginType = resolveLoginType(provider, parsed.type);
        if (loginType === "api_key") {
          let apiKey: string;
          if (parsed.apiKeyEnv !== undefined) {
            apiKey = readApiKeyFromEnv(out.env, parsed.apiKeyEnv);
          } else {
            apiKey = await out.readSecret(`API key for ${providerId}`);
          }
          secrets = [apiKey];
          if (apiKey.trim().length === 0) {
            out.error("API key is required");
            return 1;
          }
          const status = await loginWithApiKey(cwd, providerId, apiKey, ctx);
          out.log(formatStatus(status));
          return 0;
        }
        const abort = new AbortController();
        const onSigInt = () => abort.abort();
        process.once("SIGINT", onSigInt);
        try {
          const interaction = out.createAuthInteraction(abort.signal);
          const result = await loginWithOauth(cwd, providerId, interaction, ctx);
          if (result.warning) {
            out.error(result.warning);
          }
          out.log(formatStatus(result.provider));
          return 0;
        } finally {
          process.removeListener("SIGINT", onSigInt);
        }
      }
      case "logout": {
        const providerId = parsed.positionals[0];
        if (!providerId) {
          out.error("Missing providerId");
          out.error(PROVIDERS_USAGE);
          return 1;
        }
        const status = await logoutProvider(cwd, providerId, ctx);
        out.log(formatStatus(status));
        return 0;
      }
      default:
        out.error(`Unknown providers subcommand: ${parsed.subcommand}`);
        out.error(PROVIDERS_USAGE);
        return 1;
    }
  } catch (err) {
    const raw =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : "Provider command failed";
    out.error(scrub(raw, secrets));
    return 1;
  }
}

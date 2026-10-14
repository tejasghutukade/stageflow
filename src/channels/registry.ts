import { existsSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";
import { loadConnectionsFile, type ConnectionsFile } from "./config.js";
import { ChannelError } from "./errors.js";
import { channelProviders } from "./providers.js";
import { resolveSecrets } from "./secrets.js";
import { ChannelSecretStore, type SecretReader } from "./secretStore.js";
import { globalCredentialRoot, globalStageflowHome } from "../project/globalHome.js";
import type {
  AnyChannelProvider, ConnectionEntry, ConnectionSummary, CredentialEntry,
  ResolvedConnection, ResolvedCredential,
} from "./types.js";

export const CONNECTIONS_FILE_NAME = "connections.yaml";

function hostConnectionsFile(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.STAGEFLOW_HOME?.trim() || (env === process.env ? globalStageflowHome() : undefined);
  return home ? path.join(path.resolve(home), CONNECTIONS_FILE_NAME) : undefined;
}

/**
 * Where connections live. Connections are host-level, like provider credentials, so the default is
 * `$STAGEFLOW_HOME/connections.yaml`. A `connections.yaml` in the project root takes precedence when
 * it exists (CI and checked-in setups), and `STAGEFLOW_CONNECTIONS_FILE` overrides both.
 */
export function connectionsFilePath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.STAGEFLOW_CONNECTIONS_FILE?.trim();
  if (override) return path.isAbsolute(override) ? path.resolve(override) : path.resolve(cwd, override);
  const project = path.join(path.resolve(cwd), CONNECTIONS_FILE_NAME);
  if (existsSync(project)) return project;
  return hostConnectionsFile(env) ?? project;
}

export function defaultSecretStore(): ChannelSecretStore {
  return new ChannelSecretStore(path.join(globalCredentialRoot(), "channel-secrets.json"));
}

export type ChannelRegistryOptions = {
  cwd: string;
  providers?: readonly AnyChannelProvider[];
  env?: NodeJS.ProcessEnv;
  /** Owner scope. TODO(multi-tenant): the local default is the workspace path, like email accounts. */
  scope?: string;
  file?: string;
  /** Already parsed content, used to validate an edit before it is written. */
  parsed?: ConnectionsFile;
  secretStore?: SecretReader;
};

type LoadedConnection = ConnectionEntry & { config: unknown; displayName: string };

/** Host-owned, read-only view of `connections.yaml`. Reads return copies. */
export class ChannelRegistry {
  readonly scope: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly secretStore: SecretReader;
  private readonly providers = new Map<string, AnyChannelProvider>();
  private readonly credentials = new Map<string, CredentialEntry>();
  private readonly connections = new Map<string, LoadedConnection>();

  constructor(options: ChannelRegistryOptions) {
    this.scope = options.scope ?? path.resolve(options.cwd);
    this.env = options.env ?? process.env;
    for (const provider of options.providers ?? channelProviders()) this.providers.set(provider.id, provider);
    this.secretStore = options.secretStore ?? { get: name => defaultSecretStore().get(name) };
    const file = options.parsed ?? loadConnectionsFile(options.file ?? connectionsFilePath(options.cwd, this.env));
    for (const credential of file.credentials) this.addCredential(credential);
    for (const entry of file.connections) this.addConnection(entry);
  }

  list(): ConnectionSummary[] {
    return [...this.connections.values()].map(entry => this.summarize(entry));
  }

  private summarize(loaded: LoadedConnection): ConnectionSummary {
    const identity = this.providers.get(loaded.provider)?.describe?.(loaded.config)?.identity;
    return {
      id: loaded.id, scope: this.scope, provider: loaded.provider, displayName: loaded.displayName,
      enabled: loaded.enabled, ...(identity ? { identity } : {}),
      ...(loaded.credential ? { credential: loaded.credential } : {}),
      secrets: Object.fromEntries(Object.entries(loaded.secrets).map(([field, ref]) => [field, ref.startsWith("store:") ? "store" : "env"])) as Record<string, "env" | "store">,
    };
  }

  get(id: string, requireEnabled = true): ConnectionSummary {
    return this.summarize(this.entry(id, requireEnabled));
  }

  providerById(providerId: string): AnyChannelProvider {
    return this.requireProvider(providerId);
  }

  providerList(): AnyChannelProvider[] {
    return [...this.providers.values()];
  }

  hasCredential(id: string): boolean {
    return this.credentials.has(id);
  }

  /** Resolves a shared credential by id, for providers that reference one. */
  resolveCredential(id: string): ResolvedCredential {
    const entry = this.credentials.get(id);
    if (!entry) throw new ChannelError("CHANNEL_INVALID_INPUT", false, { field: "credential" });
    return { id: entry.id, provider: entry.provider, secrets: resolveSecrets(entry.secrets, this.env, `credential:${entry.id}`, this.secretStore) };
  }

  hasConnection(id: string): boolean {
    return this.connections.has(id);
  }

  providerFor(id: string): AnyChannelProvider {
    return this.requireProvider(this.entry(id, false).provider);
  }

  validateTarget(id: string, target: unknown): unknown {
    const result = this.providerFor(id).validateTarget(target);
    if (!result.ok) throw new ChannelError("CHANNEL_TARGET_INVALID", false, { connectionId: id });
    return result.value;
  }

  /** Reads secrets from the environment at call time. Values are never cached on the registry. */
  resolve(id: string, requireEnabled = true): ResolvedConnection {
    const entry = this.entry(id, requireEnabled);
    const secrets = resolveSecrets(entry.secrets, this.env, entry.id, this.secretStore);
    const credentialEntry = entry.credential ? this.credentials.get(entry.credential) : undefined;
    const credential: ResolvedCredential | undefined = credentialEntry && {
      id: credentialEntry.id,
      provider: credentialEntry.provider,
      secrets: resolveSecrets(credentialEntry.secrets, this.env, `credential:${credentialEntry.id}`, this.secretStore),
    };
    return sealed({
      id: entry.id, scope: this.scope, provider: entry.provider, displayName: entry.displayName,
      config: structuredClone(entry.config), secrets, ...(credential ? { credential } : {}),
    });
  }

  private entry(id: string, requireEnabled: boolean): LoadedConnection {
    const entry = this.connections.get(id);
    if (!entry) throw new ChannelError("CHANNEL_NOT_FOUND", false, { connectionId: id });
    if (requireEnabled && !entry.enabled) throw new ChannelError("CHANNEL_DISABLED", false, { connectionId: id });
    return entry;
  }

  private requireProvider(id: string): AnyChannelProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new ChannelError("CHANNEL_PROVIDER_UNSUPPORTED");
    return provider;
  }

  private addCredential(entry: CredentialEntry): void {
    this.credentials.set(entry.id, entry);
  }

  private addConnection(entry: ConnectionEntry): void {
    const provider = this.providers.get(entry.provider);
    if (!provider) throw new ChannelError("CHANNEL_PROVIDER_UNSUPPORTED", false, { connectionId: entry.id });
    const config = provider.validateConfig(entry.config);
    if (!config.ok) throw new ChannelError("CHANNEL_INVALID_INPUT", false, { connectionId: entry.id, field: "config" });
    this.checkSecretNames(provider, entry);
    this.checkCredential(provider, entry);
    this.connections.set(entry.id, {
      ...entry, config: config.value, displayName: entry.displayName ?? entry.id,
    });
  }

  private checkSecretNames(provider: AnyChannelProvider, entry: ConnectionEntry): void {
    const allowed = new Set([...provider.secrets.required, ...(provider.secrets.optional ?? [])]);
    for (const name of Object.keys(entry.secrets)) {
      if (!allowed.has(name)) throw new ChannelError("CHANNEL_INVALID_INPUT", false, { connectionId: entry.id, field: name });
    }
    for (const name of provider.secrets.required) {
      if (!(name in entry.secrets)) throw new ChannelError("CHANNEL_INVALID_INPUT", false, { connectionId: entry.id, field: name });
    }
  }

  private checkCredential(provider: AnyChannelProvider, entry: ConnectionEntry): void {
    if (!provider.credentialProvider) {
      if (entry.credential) throw new ChannelError("CHANNEL_INVALID_INPUT", false, { connectionId: entry.id, field: "credential" });
      return;
    }
    const credential = entry.credential ? this.credentials.get(entry.credential) : undefined;
    if (!credential || credential.provider !== provider.credentialProvider) {
      throw new ChannelError("CHANNEL_INVALID_INPUT", false, { connectionId: entry.id, field: "credential" });
    }
  }
}

export function sealed<T extends ResolvedConnection>(value: T): T {
  const { secrets, credential, ...visible } = value;
  const out = { ...visible } as Record<string, unknown>;
  Object.defineProperty(out, "secrets", { value: secrets, enumerable: false });
  if (credential) {
    const { secrets: credentialSecrets, ...credentialVisible } = credential;
    const sealedCredential: Record<string, unknown> = { ...credentialVisible };
    Object.defineProperty(sealedCredential, "secrets", { value: credentialSecrets, enumerable: false });
    Object.defineProperty(out, "credential", { value: sealedCredential, enumerable: false });
  }
  Object.defineProperty(out, "toJSON", { value: () => visible, enumerable: false });
  Object.defineProperty(out, inspect.custom, { value: () => ({ ...visible, secrets: "[redacted]" }), enumerable: false });
  return out as T;
}

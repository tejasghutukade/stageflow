import { z } from "zod";
import { parseConnectionsYaml } from "./config.js";
import { addConnectionYaml, removeConnectionYaml, toYamlEntry, updateConnectionYaml, type ConnectionPatch } from "./configWriter.js";
import { ConnectionEdits } from "./connectionEdits.js";
import { ChannelError, type ChannelErrorCode } from "./errors.js";
import { ChannelHealthMonitor, type ChannelHealthOptions } from "./health.js";
import { channelHostFor, releaseChannelHost, reloadChannelHosts, type ChannelHost } from "./host.js";
import { ChannelRegistry, connectionsFilePath, defaultSecretStore, sealed } from "./registry.js";
import { STORE_NAME_PATTERN } from "./secretStore.js";
import { stageChannelLimit } from "./stageChannels.js";
import type { ConnectionHealth, ConnectionSummary, ResolvedConnection, SecretRef } from "./types.js";

export type ChannelListing = {
  connections: Array<ConnectionSummary & { health?: ConnectionHealth }>;
  /** Set when `connections.yaml` could not be loaded. The file's content is never included. */
  error?: ChannelErrorCode;
  limits: { channelsPerStage: number };
};

export type ChannelService = {
  list(): ChannelListing;
  /** Runs one live check now. Returns undefined when the connection is unknown or disabled. */
  checkNow(id: string): Promise<ConnectionHealth | undefined>;
  /** Checks entered values without saving anything. */
  test(input: unknown): Promise<ConnectionHealth>;
  /** Static check of a pinned recipient for a connection. No network, no secret read. */
  validateTarget(id: string, input: unknown): { ok: true } | { ok: false; issues: string[] };
  create(input: unknown): Promise<{ id: string; health: ConnectionHealth }>;
  update(id: string, input: unknown): Promise<{ health?: ConnectionHealth }>;
  remove(id: string): Promise<void>;
  stop(): Promise<void>;
};

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const fieldSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const valueSchema = z.string().min(1).max(8192).regex(/^[^\r\n\0]+$/);
const secretsInput = z.record(fieldSchema, valueSchema);
const createSchema = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  id: idSchema.optional(),
  displayName: z.string().min(1).max(200).optional(),
  config: z.record(z.string(), z.unknown()).default({}),
  secrets: secretsInput.default({}),
  credential: z.union([idSchema, z.object({ id: idSchema.optional(), secrets: secretsInput })]).optional(),
}).strict();
const targetText = z.union([z.string().min(1).max(500), z.number().int()]);
const targetSchema = z.object({
  to: z.union([targetText, z.array(targetText).min(1).max(20)]),
  cc: z.array(targetText).min(1).max(20).optional(),
  template: z.record(z.string(), z.unknown()).optional(),
}).strict().transform(value => ({
  ...value,
  to: Array.isArray(value.to) ? value.to.map(String) : String(value.to),
  ...(value.cc ? { cc: value.cc.map(String) } : {}),
}));
const updateSchema = z.object({
  displayName: z.string().max(200).nullable().optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  secrets: secretsInput.optional(),
}).strict();

const limits = (): ChannelListing["limits"] => ({ channelsPerStage: stageChannelLimit() });
const invalid = (field?: string): ChannelError => new ChannelError("CHANNEL_INVALID_INPUT", false, field ? { field } : undefined);

/**
 * Host-side read and edit model for the Connections page. A `connections.yaml` that fails to load
 * does not stop the host: the listing reports the error code and stages that use channels fail on
 * their own, while every other stage is unaffected. Edits keep secrets out of the YAML: each value
 * goes to the secret store and the file gets a `store:NAME` reference.
 */
export function startChannelService(
  cwd: string,
  options: Pick<ChannelHealthOptions, "intervalMs" | "timeoutMs"> = {},
): ChannelService {
  const file = (): string => connectionsFilePath(cwd);
  const store = defaultSecretStore();
  let host: ChannelHost | undefined;
  let monitor: ChannelHealthMonitor | undefined;
  let error: ChannelErrorCode | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work, work);
    chain = next.catch(() => undefined);
    return next;
  };

  const startMonitor = (): void => {
    monitor = host ? new ChannelHealthMonitor({ registry: host.registry, intervalMs: options.intervalMs, timeoutMs: options.timeoutMs }) : undefined;
    monitor?.start();
  };

  const load = (): void => {
    error = undefined;
    try {
      host = channelHostFor(cwd);
    } catch (caught) {
      host = undefined;
      error = caught instanceof ChannelError ? caught.code : "CHANNEL_INVALID_INPUT";
    }
    startMonitor();
  };

  const reload = async (): Promise<void> => {
    await monitor?.stop();
    reloadChannelHosts();
    if (host) {
      try {
        host.reload();
      } catch (caught) {
        error = caught instanceof ChannelError ? caught.code : "CHANNEL_INVALID_INPUT";
        monitor = undefined;
        return;
      }
      error = undefined;
      startMonitor();
    } else {
      load();
    }
  };

  load();

  const requireHost = (): ChannelHost => {
    if (!host) throw new ChannelError(error ?? "CHANNEL_STORAGE_FAILED");
    return host;
  };

  /** Validates the edit against the real provider rules before anything is written. */
  const validate = (text: string): void => {
    const parsed = parseConnectionsYaml(text);
    new ChannelRegistry({ cwd, parsed, secretStore: store, providers: requireHost().registry.providerList() });
  };

  const edits = new ConnectionEdits({ file, store, validate });

  const uniqueId = (base: string, taken: (id: string) => boolean): string => {
    if (!taken(base)) return base;
    for (let n = 2; n < 1000; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
    throw invalid("id");
  };

  const secretRefs = (prefix: string, secrets: Record<string, string>): Record<string, SecretRef> => {
    const refs: Record<string, SecretRef> = {};
    for (const field of Object.keys(secrets)) {
      const name = `${prefix}.${field}`;
      if (!STORE_NAME_PATTERN.test(name)) throw invalid(field);
      refs[field] = `store:${name}`;
    }
    return refs;
  };

  const draft = (input: z.infer<typeof createSchema>, id: string): ResolvedConnection => {
    const registry = requireHost().registry;
    const provider = registry.providerById(input.provider);
    const config = provider.validateConfig(input.config);
    if (!config.ok) throw invalid("config");
    const allowed = new Set([...provider.secrets.required, ...(provider.secrets.optional ?? [])]);
    for (const field of Object.keys(input.secrets)) if (!allowed.has(field)) throw invalid(field);
    for (const field of provider.secrets.required) if (!(field in input.secrets)) throw invalid(field);
    let credential: ResolvedConnection["credential"];
    if (provider.credentialProvider) {
      if (typeof input.credential === "string") credential = registry.resolveCredential(input.credential);
      else if (input.credential) credential = { id: input.credential.id ?? "draft", provider: provider.credentialProvider, secrets: input.credential.secrets };
      else throw invalid("credential");
    } else if (input.credential) {
      throw invalid("credential");
    }
    return sealed({
      id, scope: registry.scope, provider: input.provider, displayName: input.displayName ?? id,
      config: config.value, secrets: input.secrets, ...(credential ? { credential } : {}),
    } as ResolvedConnection);
  };

  const parseCreate = (input: unknown): z.infer<typeof createSchema> => {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    return parsed.data;
  };

  return {
    list() {
      if (!host) return { connections: [], ...(error ? { error } : {}), limits: limits() };
      const health = monitor?.snapshot() ?? {};
      return {
        connections: host.registry.list().map(summary => ({ ...summary, ...(health[summary.id] ? { health: health[summary.id] } : {}) })),
        ...(error ? { error } : {}),
        limits: limits(),
      };
    },

    async checkNow(id) {
      if (!host || !monitor) return undefined;
      try {
        host.registry.get(id);
      } catch {
        return undefined;
      }
      return monitor.checkNow(id);
    },

    validateTarget(id, input) {
      const parsed = targetSchema.safeParse(input);
      if (!parsed.success) return { ok: false, issues: ["target"] };
      const provider = requireHost().registry.providerFor(id);
      const result = provider.validateTarget(parsed.data);
      return result.ok ? { ok: true } : { ok: false, issues: result.issues };
    },

    async test(input) {
      const parsed = parseCreate(input);
      const connection = draft(parsed, parsed.id ?? "draft");
      const provider = requireHost().registry.providerById(parsed.provider);
      const checkedAt = new Date().toISOString();
      try {
        return await provider.check(connection, AbortSignal.timeout(10000));
      } catch (caught) {
        const failure = caught instanceof ChannelError ? caught : new ChannelError("CHANNEL_CONNECTION_FAILED", true);
        return { state: "failed", checkedAt, error: { code: failure.code, retryable: failure.retryable } };
      }
    },

    create(input) {
      return serialized(async () => {
        const parsed = parseCreate(input);
        const registry = requireHost().registry;
        const provider = registry.providerById(parsed.provider);
        const id = parsed.id ?? uniqueId(parsed.provider, candidate => registry.hasConnection(candidate));
        if (registry.hasConnection(id)) throw new ChannelError("CHANNEL_OPERATION_CONFLICT", false, { connectionId: id });
        draft(parsed, id);

        const secrets: Record<string, string> = {};
        let credentialYaml: { id: string; provider: string; secrets: Record<string, string> } | undefined;
        let credentialId: string | undefined;
        if (provider.credentialProvider) {
          if (typeof parsed.credential === "string") {
            credentialId = parsed.credential;
          } else if (parsed.credential) {
            credentialId = parsed.credential.id ?? uniqueId(`${provider.credentialProvider}-main`, candidate => registry.hasCredential(candidate));
            credentialYaml = { id: credentialId, provider: provider.credentialProvider, secrets: secretRefs(`credential.${credentialId}`, parsed.credential.secrets) };
            for (const [field, value] of Object.entries(parsed.credential.secrets)) secrets[`credential.${credentialId}.${field}`] = value;
          }
        }
        const refs = secretRefs(`connection.${id}`, parsed.secrets);
        for (const [field, value] of Object.entries(parsed.secrets)) secrets[`connection.${id}.${field}`] = value;
        const entry = toYamlEntry({
          id, provider: parsed.provider, enabled: true, config: parsed.config, secrets: refs,
          ...(parsed.displayName ? { displayName: parsed.displayName } : {}),
          ...(credentialId ? { credential: credentialId } : {}),
        });
        edits.apply({ secrets, rewrite: text => ({ text: addConnectionYaml(text, entry, credentialYaml) }) });
        await reload();
        const health = (await this.checkNow(id)) ?? { state: "failed" as const, checkedAt: new Date().toISOString(), error: { code: "CHANNEL_CONNECTION_FAILED" as const, retryable: true } };
        return { id, health };
      });
    },

    update(id, input) {
      return serialized(async () => {
        const parsed = updateSchema.safeParse(input);
        if (!parsed.success) throw invalid();
        const registry = requireHost().registry;
        const current = registry.get(id, false);
        const provider = registry.providerById(current.provider);
        const patch: ConnectionPatch = {};
        if (parsed.data.displayName !== undefined) patch.displayName = parsed.data.displayName;
        if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled;
        if (parsed.data.config !== undefined) {
          const config = provider.validateConfig(parsed.data.config);
          if (!config.ok) throw invalid("config");
          patch.config = parsed.data.config;
        }
        const allowed = new Set([...provider.secrets.required, ...(provider.secrets.optional ?? [])]);
        const secrets = parsed.data.secrets ?? {};
        for (const field of Object.keys(secrets)) if (!allowed.has(field)) throw invalid(field);
        const refs = secretRefs(`connection.${id}`, secrets);
        if (Object.keys(refs).length) patch.secrets = refs;
        edits.apply({
          secrets: Object.fromEntries(Object.entries(secrets).map(([field, value]) => [`connection.${id}.${field}`, value])),
          rewrite: text => ({ text: updateConnectionYaml(text, id, patch) }),
        });
        await reload();
        const enabled = parsed.data.enabled ?? current.enabled;
        return enabled ? { health: await this.checkNow(id) } : {};
      });
    },

    remove(id) {
      return serialized(async () => {
        requireHost().registry.get(id, false);
        edits.apply({
          rewrite: text => {
            const removed = removeConnectionYaml(text, id);
            return {
              text: removed.text,
              dropSecretPrefixes: [`connection.${id}.`, ...(removed.removedCredential ? [`credential.${removed.removedCredential}.`] : [])],
            };
          },
        });
        await reload();
      });
    },

    stop() {
      return serialized(async () => {
        await monitor?.stop();
        if (host) await releaseChannelHost(cwd);
      });
    },
  };
}

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getCursorHostStatus } from "../agent/cursorProvider.js";
import { globalModelFromManifest } from "../config/resolveModel.js";
import { resolveStageflowContext } from "../project/resolveStageflowContext.js";
import { resolveCredentialBinding } from "../runtime/credentialBinding.js";
import { readFactorySettings } from "../runtime/settingsFile.js";

/** Last resort when nothing is connected and nothing is configured. Pi resolves unknown OpenRouter ids. */
export const LAST_RESORT_MODEL = "openrouter/nvidia/nemotron-3.5-lightning:free";

export type CatalogModel = {
  /** `provider/model`, the form Pi resolves and stage, pipeline and agent files store. */
  id: string;
  provider: string;
  name: string;
  free: boolean;
  contextWindow?: number;
  reasoning?: boolean;
  /** The provider runs its own file and shell tools beside Pi's, so agent grants and approvals cannot hold. */
  nativeTools: boolean;
};

export type CatalogProvider = {
  id: string;
  name: string;
  models: CatalogModel[];
  /** `live`: Pi's catalog for this provider refreshed; `fallback`: built-in or cached list after an error. */
  source: "live" | "fallback";
  error?: string;
};

export type ModelCatalogSnapshot = {
  /** Connected providers only. */
  providers: CatalogProvider[];
  /** Every model id across `providers`, sorted. */
  models: string[];
  fetchedAt: string;
};

/** The slice of Pi's ModelRuntime the catalog reads. */
export type CatalogRuntime = {
  getProviders(): ReadonlyArray<{ id: string; name?: string }>;
  getProviderAuthStatus(providerId: string): { configured: boolean };
  listCredentials(): Promise<ReadonlyArray<{ providerId: string }>>;
  getModels(providerId?: string): ReadonlyArray<{
    id: string;
    name?: string;
    provider: string;
    contextWindow?: number;
    reasoning?: boolean;
    cost?: { input?: number; output?: number };
  }>;
  refresh(options?: {
    allowNetwork?: boolean;
    providers?: readonly string[];
    force?: boolean;
    signal?: AbortSignal;
  }): Promise<{ errors: ReadonlyMap<string, Error> } | void>;
};

export type CursorModelSource = () => { connected: boolean; modelIds: string[] };

export type ModelCatalogOptions = {
  cwd: string;
  createRuntime?: (authPath: string) => Promise<CatalogRuntime>;
  cursor?: CursorModelSource;
  now?: () => number;
  /** How long a built snapshot is reused before connections are re-read. */
  ttlMs?: number;
  refreshTimeoutMs?: number;
};

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_REFRESH_TIMEOUT_MS = 10_000;

const NOTHING_CONNECTED: CatalogRuntime = {
  getProviders: () => [],
  getProviderAuthStatus: () => ({ configured: false }),
  listCredentials: async () => [],
  getModels: () => [],
  refresh: async () => undefined,
};

// ModelRuntime.create writes auth.json when it is missing; listing models must not, so no file means nothing connected.
const defaultCreateRuntime = async (authPath: string): Promise<CatalogRuntime> =>
  !existsSync(authPath)
    ? NOTHING_CONNECTED
    : (ModelRuntime.create({
    authPath,
    // Same layout as the provider routes: models.json and models-store.json sit beside auth.json.
    modelsPath: path.join(path.dirname(authPath), "models.json"),
    refreshOnCreate: false,
  }) as unknown as Promise<CatalogRuntime>);

/** Cursor models come from the extension's cached list; they only count once Cursor is connected. */
function defaultCursorSource(authPath: string): CursorModelSource {
  return () => {
    const status = getCursorHostStatus();
    const connected = status.cursorApiKeyConfigured && status.cursorSdkReady;
    if (!connected) return { connected, modelIds: [] };
    const file = path.join(path.dirname(authPath), "cursor-sdk-model-list.json");
    try {
      if (!existsSync(file)) return { connected, modelIds: [] };
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { models?: Array<{ id?: unknown }> };
      const ids = (parsed.models ?? [])
        .map((entry) => (typeof entry.id === "string" ? entry.id : ""))
        .filter((id) => id.length > 0)
        .map((id) => `cursor/${id === "default" ? "auto" : id}`);
      return { connected, modelIds: ids };
    } catch {
      return { connected, modelIds: [] };
    }
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFree(model: { id: string; cost?: { input?: number; output?: number } }): boolean {
  if (model.id.endsWith(":free")) return true;
  return model.cost !== undefined && model.cost.input === 0 && model.cost.output === 0;
}

/**
 * The one place model lists and the default model come from. Models are those of connected
 * providers, asked of Pi's registry (live where the provider lists models, built-in otherwise).
 */
export class ModelCatalog {
  private readonly options: ModelCatalogOptions;
  private cached: { snapshot: ModelCatalogSnapshot; builtAt: number } | undefined;
  private inflight: Promise<ModelCatalogSnapshot> | undefined;
  private lastDefault: string | undefined;

  constructor(options: ModelCatalogOptions) {
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Cached list; rebuilt when older than the TTL or when `refresh` forces Pi to refetch provider catalogs. */
  async snapshot(options: { refresh?: boolean } = {}): Promise<ModelCatalogSnapshot> {
    const ttl = this.options.ttlMs ?? DEFAULT_TTL_MS;
    if (!options.refresh && this.cached && this.now() - this.cached.builtAt < ttl) return this.cached.snapshot;
    if (this.inflight && !options.refresh) return this.inflight;
    const run: Promise<ModelCatalogSnapshot> = this.build(options.refresh === true)
      .then((snapshot) => {
        this.cached = { snapshot, builtAt: this.now() };
        return snapshot;
      })
      .catch((error) => {
        // Keep serving the last good list when a rebuild fails outright.
        if (this.cached) return this.cached.snapshot;
        throw error;
      })
      .finally(() => {
        if (this.inflight === run) this.inflight = undefined;
      });
    this.inflight = run;
    return run;
  }

  refresh(): Promise<ModelCatalogSnapshot> {
    return this.snapshot({ refresh: true });
  }

  /** True when the id belongs to a connected provider. Custom ids still run; this only drives warnings. */
  async isKnown(id: string): Promise<boolean> {
    const wanted = id.trim();
    if (wanted.length === 0) return false;
    return (await this.snapshot()).models.includes(wanted);
  }

  /**
   * stageflow.yaml `model`, then the Settings workshop model, then the catalog's pick: the last-resort
   * model when connected, else the first free model, else the first model, else the last resort.
   */
  async defaultModel(): Promise<string> {
    const configured = await this.configuredDefault();
    if (configured) return this.remember(configured);
    return this.remember(this.pick(await this.snapshot().catch(() => undefined)));
  }

  /** Synchronous default for call sites that cannot await: the last resolved default, else the last resort. */
  peekDefault(): string {
    return this.lastDefault ?? this.configuredDefaultSync() ?? this.pick(this.cached?.snapshot);
  }

  private remember(id: string): string {
    this.lastDefault = id;
    lastKnownDefault = id;
    return id;
  }

  private async configuredDefault(): Promise<string | undefined> {
    const ctx = await resolveStageflowContext(this.options.cwd);
    const model = globalModelFromManifest(ctx.manifest) ?? readFactorySettings(this.options.cwd).workshopModel;
    const trimmed = model?.trim();
    return trimmed ? trimmed : undefined;
  }

  private configuredDefaultSync(): string | undefined {
    const trimmed = readFactorySettings(this.options.cwd).workshopModel?.trim();
    return trimmed ? trimmed : undefined;
  }

  private pick(snapshot: ModelCatalogSnapshot | undefined): string {
    const all = snapshot?.providers.flatMap((provider) => provider.models) ?? [];
    if (all.some((model) => model.id === LAST_RESORT_MODEL)) return LAST_RESORT_MODEL;
    return all.find((model) => model.free && !model.nativeTools)?.id ?? all.find((model) => !model.nativeTools)?.id ?? all[0]?.id ?? LAST_RESORT_MODEL;
  }

  private async build(force: boolean): Promise<ModelCatalogSnapshot> {
    const authPath = resolveCredentialBinding(this.options.cwd).authPath;
    const runtime = await (this.options.createRuntime ?? defaultCreateRuntime)(authPath);
    const credentials = new Set((await runtime.listCredentials().catch(() => [])).map((entry) => entry.providerId));
    const connected = runtime
      .getProviders()
      .filter((provider) => credentials.has(provider.id) || runtime.getProviderAuthStatus(provider.id).configured);
    const ids = connected.map((provider) => provider.id);

    // Restore the cached catalogs first, then ask the providers; a failure leaves the cached or built-in list.
    const errors = new Map<string, Error>();
    if (ids.length > 0) {
      await runtime.refresh({ allowNetwork: false, providers: ids }).catch(() => undefined);
      const signal = AbortSignal.timeout(this.options.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS);
      try {
        const result = await runtime.refresh({ allowNetwork: true, providers: ids, force, signal });
        if (result) for (const [id, error] of result.errors) errors.set(id, error);
      } catch (error) {
        for (const id of ids) errors.set(id, error instanceof Error ? error : new Error(errorMessage(error)));
      }
    }

    const providers: CatalogProvider[] = connected.map((provider) => {
      const failure = errors.get(provider.id);
      return {
        id: provider.id,
        name: provider.name ?? provider.id,
        source: failure ? "fallback" : "live",
        ...(failure ? { error: errorMessage(failure) } : {}),
        models: runtime
          .getModels(provider.id)
          .map((model): CatalogModel => ({
            id: `${model.provider}/${model.id}`,
            provider: model.provider,
            name: model.name ?? model.id,
            free: isFree(model),
            ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
            ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
            nativeTools: false,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    });

    const cursor = (this.options.cursor ?? defaultCursorSource(authPath))();
    if (cursor.connected && cursor.modelIds.length > 0) {
      providers.push({
        id: "cursor",
        name: "Cursor",
        source: "live",
        models: [...new Set(cursor.modelIds)].sort().map((id) => ({
          id,
          provider: "cursor",
          name: id.slice("cursor/".length),
          free: false,
          nativeTools: true,
        })),
      });
    }

    providers.sort((a, b) => a.name.localeCompare(b.name));
    return {
      providers,
      models: providers.flatMap((provider) => provider.models.map((model) => model.id)).sort((a, b) => a.localeCompare(b)),
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }
}

const catalogs = new Map<string, ModelCatalog>();
let lastKnownDefault: string | undefined;

/**
 * The most recently resolved default, for call sites that cannot await. Hosts resolve it at boot,
 * so this is the catalog's answer, not a second source.
 */
export function peekDefaultModel(): string {
  return lastKnownDefault ?? LAST_RESORT_MODEL;
}

/** The Host's catalog for a working directory, shared by every consumer in the process. */
export function getModelCatalog(cwd: string): ModelCatalog {
  const key = path.resolve(cwd);
  let catalog = catalogs.get(key);
  if (!catalog) {
    catalog = new ModelCatalog({ cwd: key });
    catalogs.set(key, catalog);
  }
  return catalog;
}

export function resetModelCatalogsForTests(): void {
  catalogs.clear();
  lastKnownDefault = undefined;
}

export function setModelCatalogForTests(cwd: string, catalog: ModelCatalog): void {
  catalogs.set(path.resolve(cwd), catalog);
}

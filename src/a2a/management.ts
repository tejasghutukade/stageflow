import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { ZodError } from "zod";
import type { SecretReader } from "../channels/secretStore.js";
import { writeFileAtomic } from "../config/atomicWrite.js";
import {
  CatalogPathError,
  isInsideProjectRoot,
  resolveCatalogRelativePath,
} from "../config/catalogRelativePath.js";
import { resolveCatalogRoots, type CatalogRoot } from "../config/resolveCatalogRoots.js";
import type { RunStore } from "../runstore/port.js";
import {
  A2A_CALLER_STORE_PREFIX,
  a2aIdentifier,
  describePipelineStages,
  isA2aConfigTurnedOff,
  normalizePublicUrl,
  parsePublicationConfig,
  previewPublication,
  tokenDigestHex,
  type PipelineStageOption,
  type PublicationConfig,
  type PublicationContract,
  type PublicationRegistry,
} from "./registry.js";
import type { A2aHost } from "./server.js";

export type A2aSecretStore = SecretReader & {
  set(name: string, value: string): void;
  delete(name: string): void;
};

export class A2aManagementError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "A2aManagementError";
  }
}

export type A2aManagementOptions = {
  host: A2aHost;
  secrets: A2aSecretStore;
  store: RunStore;
  env: NodeJS.ProcessEnv;
  /** The file the API writes; read again on every change so a project file that appears later is followed. */
  configPath: () => string;
};

/** A publication as the API shows and accepts it: `project_root` is a catalog wire id, paths are relative to that root. */
export type A2aPublicationView = Omit<PublicationConfig, "allowed_callers"> & {
  allowed_callers: string[];
  revision?: string;
  root_unmanaged?: true;
};

const OUTSIDE_PROJECT = "(outside project)";

type RawConfig = {
  version: 1;
  public_url?: string;
  callers: Array<Record<string, unknown>>;
  publications: Array<Record<string, unknown>>;
};

const PATH_FIELDS = ["project_root", "pipeline", "input_schema"] as const;

function issueText(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
}

function invalid(message: string, code = "a2a_invalid_request"): A2aManagementError {
  return new A2aManagementError(code, message, 400);
}

export class A2aManagement {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: A2aManagementOptions) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private get target(): string {
    return this.options.configPath();
  }

  status(): A2aHost["status"] {
    return this.options.host.status;
  }

  reload(): Promise<A2aHost["status"]> {
    return this.serial(async () => {
      const result = await this.options.host.reload(this.target);
      if (!result.ok) throw new A2aManagementError(result.error.code, result.error.message, 409);
      return this.options.host.status;
    });
  }

  enable(input: { public_url?: string }): Promise<A2aHost["status"]> {
    return this.serial(async () => {
      const target = this.target;
      const existing = await this.readText(target);
      if (existing === undefined) {
        const config: RawConfig = { version: 1, callers: [], publications: [] };
        if (input.public_url !== undefined) {
          try {
            config.public_url = normalizePublicUrl(input.public_url);
          } catch (error) {
            throw invalid(error instanceof Error ? error.message : "Invalid public_url");
          }
        } else if (!this.options.env.STAGEFLOW_PUBLIC_URL) {
          throw invalid("public_url is required because STAGEFLOW_PUBLIC_URL is not set", "a2a_public_url_required");
        }
        await writeFileAtomic(target, stringify(config));
        const result = await this.options.host.reload(target);
        if (!result.ok) {
          await rm(target, { force: true });
          throw invalid(result.error.message, "a2a_config_invalid");
        }
        return this.options.host.status;
      }
      const turnedOff = await this.turnedOff(target);
      if (turnedOff) await writeFileAtomic(target, stringify(this.withoutEnabledFlag(existing)));
      const result = await this.options.host.reload(target);
      if (!result.ok) {
        if (turnedOff) {
          await writeFileAtomic(target, existing);
          await this.options.host.reload(target);
        }
        throw new A2aManagementError(result.error.code, result.error.message, 409);
      }
      return this.options.host.status;
    });
  }

  disable(): Promise<A2aHost["status"]> {
    return this.serial(async () => {
      const target = this.target;
      const existing = await this.readText(target);
      if (existing === undefined) throw new A2aManagementError("a2a_not_enabled", "A2A is not turned on", 409);
      if (!(await this.turnedOff(target))) {
        await writeFileAtomic(target, stringify({ ...(parse(existing) as object), enabled: false }));
      }
      const result = await this.options.host.reload(target);
      if (!result.ok) throw new A2aManagementError(result.error.code, result.error.message, 409);
      return this.options.host.status;
    });
  }

  private async turnedOff(target: string): Promise<boolean> {
    try {
      return await isA2aConfigTurnedOff(target);
    } catch {
      return false;
    }
  }

  private withoutEnabledFlag(text: string): object {
    const { enabled: _enabled, ...rest } = parse(text) as Record<string, unknown>;
    return rest;
  }

  listCallers(): Array<{ id: string; token_source: "store" | "env" }> {
    return (this.options.host.registry()?.callers() ?? []).map(({ id, source }) => ({ id, token_source: source }));
  }

  createCaller(id: string): Promise<{ id: string; token: string; token_source: "store" }> {
    const parsed = a2aIdentifier.safeParse(id);
    if (!parsed.success) throw invalid("Caller id must be 1-80 letters, digits, '_' or '-', starting with a letter or digit");
    return this.serial(async () => {
      const { config } = await this.readConfig();
      if (config.callers.some((caller) => caller.id === id)) {
        throw new A2aManagementError("a2a_caller_exists", `Caller ${id} already exists`, 409);
      }
      if (this.options.host.callerHasTasks(id)) {
        throw new A2aManagementError(
          "a2a_caller_id_retained",
          `Caller id ${id} still has retained tasks; use another id`,
          409,
        );
      }
      const token = randomBytes(24).toString("hex");
      const name = A2A_CALLER_STORE_PREFIX + id;
      this.options.secrets.set(name, tokenDigestHex(token));
      try {
        await this.commit({ ...config, callers: [...config.callers, { id, token_store: name }] });
      } catch (error) {
        this.options.secrets.delete(name);
        throw error;
      }
      return { id, token, token_source: "store" as const };
    });
  }

  revokeCaller(id: string): Promise<{ revoked: true; removed_from: string[] }> {
    return this.serial(async () => {
      const { config } = await this.readConfig();
      const caller = config.callers.find((entry) => entry.id === id);
      if (!caller) throw new A2aManagementError("a2a_caller_not_found", `Caller ${id} not found`, 404);
      const removedFrom: string[] = [];
      const publications = config.publications.map((publication) => {
        const allowed = Array.isArray(publication.allowed_callers) ? (publication.allowed_callers as string[]) : [];
        if (!allowed.includes(id)) return publication;
        removedFrom.push(String(publication.id));
        return { ...publication, allowed_callers: allowed.filter((entry) => entry !== id) };
      });
      await this.commit({ ...config, callers: config.callers.filter((entry) => entry.id !== id), publications });
      const store = caller.token_store;
      if (typeof store === "string" && store.startsWith(A2A_CALLER_STORE_PREFIX)) {
        try {
          this.options.secrets.delete(store);
        } catch {
          // The caller is already gone from the configuration; a leftover digest authenticates nobody.
        }
      }
      return { revoked: true as const, removed_from: removedFrom };
    });
  }

  async listPublications(): Promise<A2aPublicationView[]> {
    const registry = this.options.host.registry();
    if (!registry) return [];
    const roots = await this.catalogRoots();
    return registry.publicationConfigs().map((publication) => this.toView(publication, roots));
  }

  async getPublication(id: string): Promise<A2aPublicationView & { contract: PublicationContract }> {
    const found = this.live(id);
    if (!found) throw new A2aManagementError("a2a_publication_not_found", `Publication ${id} not found`, 404);
    const roots = await this.catalogRoots();
    return {
      ...this.toView(found, roots),
      contract: {
        revision: found.revision,
        inputSchema: found.inputSchema,
        outputSchema: found.outputSchema,
        artifacts: found.results.artifacts,
      },
    };
  }

  async pipelineStages(projectRoot: string, pipeline: string): Promise<PipelineStageOption[]> {
    const roots = await this.catalogRoots();
    try {
      const resolved = resolveCatalogRelativePath({ inputPath: pipeline, projectRoot, roots, fieldName: "pipeline" });
      return await describePipelineStages(resolved.absolutePath, resolved.root.path);
    } catch (error) {
      if (error instanceof CatalogPathError) throw invalid(error.message, "a2a_path_invalid");
      throw invalid(error instanceof Error ? error.message : "The pipeline could not be loaded", "a2a_publication_invalid");
    }
  }

  async previewPublication(body: unknown): Promise<PublicationContract> {
    const roots = await this.catalogRoots();
    const entry = this.normalize(this.draft(body), roots);
    return this.validatePublication(entry);
  }

  createPublication(body: unknown): Promise<A2aPublicationView> {
    return this.serial(async () => {
      const { config } = await this.readConfig();
      const roots = await this.catalogRoots();
      const entry = this.normalize(this.draft(body), roots);
      if (config.publications.some((publication) => publication.id === entry.id)) {
        throw new A2aManagementError("a2a_publication_exists", `Publication ${entry.id} already exists`, 409);
      }
      this.assertKnownCallers(entry, config);
      await this.validatePublication(entry);
      await this.commit({ ...config, publications: [...config.publications, entry] });
      return this.toView(entry, roots);
    });
  }

  updatePublication(id: string, body: unknown): Promise<A2aPublicationView> {
    return this.serial(async () => {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Request body must be an object");
      const patch = body as Record<string, unknown>;
      if ("id" in patch && patch.id !== id) throw invalid("Publication id cannot be changed");
      const { config } = await this.readConfig();
      const index = config.publications.findIndex((publication) => publication.id === id);
      if (index === -1) throw new A2aManagementError("a2a_publication_not_found", `Publication ${id} not found`, 404);
      const roots = await this.catalogRoots();
      const stored = this.parse(config.publications[index]!);
      const { results: patchResults, ...rest } = patch;
      let merged: Record<string, unknown> = {
        ...stored,
        ...rest,
        ...(patchResults !== undefined && typeof patchResults === "object"
          ? { results: { ...stored.results, ...(patchResults as object) } }
          : {}),
        id,
      };
      let entry: PublicationConfig;
      if (PATH_FIELDS.some((field) => field in patch)) {
        const live = this.live(id);
        if (!live) throw new A2aManagementError("a2a_not_enabled", "The A2A configuration is not loaded; reload it first", 409);
        const view = this.toView(live, roots);
        merged = { ...merged, ...Object.fromEntries(PATH_FIELDS.map((field) => [field, field in patch ? patch[field] : view[field]])) };
        entry = this.normalize(this.draft(merged), roots);
      } else {
        entry = this.parse(merged);
      }
      this.assertKnownCallers(entry, config);
      await this.validatePublication(entry);
      const publications = [...config.publications];
      publications[index] = entry;
      await this.commit({ ...config, publications });
      return this.toView(entry, roots);
    });
  }

  removePublication(id: string): Promise<{ removed: true }> {
    return this.serial(async () => {
      const { config } = await this.readConfig();
      if (!config.publications.some((publication) => publication.id === id)) {
        throw new A2aManagementError("a2a_publication_not_found", `Publication ${id} not found`, 404);
      }
      await this.commit({ ...config, publications: config.publications.filter((publication) => publication.id !== id) });
      return { removed: true as const };
    });
  }

  private async readText(file: string): Promise<string | undefined> {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async readConfig(): Promise<{ config: RawConfig; text: string }> {
    const text = await this.readText(this.target);
    if (text === undefined) throw new A2aManagementError("a2a_not_enabled", "A2A is not turned on", 409);
    let raw: unknown;
    try {
      raw = parse(text);
    } catch {
      throw new A2aManagementError("a2a_config_invalid", "The A2A configuration file is not valid YAML", 409);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new A2aManagementError("a2a_config_invalid", "The A2A configuration file is not a YAML mapping", 409);
    }
    const config = raw as Record<string, unknown>;
    if (config.enabled === false) throw new A2aManagementError("a2a_not_enabled", "A2A is turned off", 409);
    const callers = config.callers ?? [];
    const publications = config.publications ?? [];
    if (!Array.isArray(callers) || !Array.isArray(publications)) {
      throw new A2aManagementError("a2a_config_invalid", "callers and publications must be lists", 409);
    }
    return { config: { ...config, version: 1, callers, publications } as RawConfig, text };
  }

  private async commit(next: RawConfig): Promise<void> {
    const target = this.target;
    const previous = await this.readText(target);
    await writeFileAtomic(target, stringify(next));
    const result = await this.options.host.reload(target);
    if (result.ok) return;
    if (previous !== undefined) await writeFileAtomic(target, previous);
    await this.options.host.reload(target);
    throw invalid(result.error.message, "a2a_config_invalid");
  }

  private parse(value: unknown): PublicationConfig {
    try {
      return parsePublicationConfig(value);
    } catch (error) {
      if (error instanceof ZodError) throw invalid(issueText(error));
      throw error;
    }
  }

  private draft(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid("Request body must be an object");
    const record = body as Record<string, unknown>;
    return { allowed_callers: [], caller_answerable_stages: [], ...record };
  }

  private async catalogRoots(): Promise<CatalogRoot[]> {
    return resolveCatalogRoots({ store: this.options.store });
  }

  /** Turns the API's catalog-relative paths into the absolute project root and root-relative paths stored in the file. */
  private normalize(draft: Record<string, unknown>, roots: CatalogRoot[]): PublicationConfig {
    const { project_root, pipeline, input_schema } = draft;
    if (typeof project_root !== "string" || typeof pipeline !== "string" || typeof input_schema !== "string") {
      return this.parse(draft);
    }
    try {
      const resolvedPipeline = resolveCatalogRelativePath({ inputPath: pipeline, projectRoot: project_root, roots, fieldName: "pipeline" });
      const resolvedSchema = resolveCatalogRelativePath({ inputPath: input_schema, projectRoot: project_root, roots, fieldName: "input_schema" });
      return this.parse({
        ...draft,
        project_root: resolvedPipeline.root.path,
        pipeline: resolvedPipeline.relativePath,
        input_schema: resolvedSchema.relativePath,
      });
    } catch (error) {
      if (error instanceof CatalogPathError) throw invalid(error.message, "a2a_path_invalid");
      throw error;
    }
  }

  private assertKnownCallers(entry: PublicationConfig, config: RawConfig): void {
    const known = new Set(config.callers.map((caller) => caller.id));
    const unknown = entry.allowed_callers.filter((id) => !known.has(id));
    if (unknown.length > 0) throw invalid(`Unknown caller: ${unknown.join(", ")}`, "a2a_unknown_caller");
    if (new Set(entry.allowed_callers).size !== entry.allowed_callers.length) {
      throw invalid("allowed_callers lists a caller twice");
    }
  }

  private async validatePublication(entry: PublicationConfig): Promise<PublicationContract> {
    try {
      return await previewPublication(entry, path.dirname(this.target));
    } catch (error) {
      if (error instanceof ZodError) throw invalid(issueText(error));
      throw invalid(error instanceof Error ? error.message : "Invalid publication", "a2a_publication_invalid");
    }
  }

  private live(id: string): ReturnType<PublicationRegistry["publicationConfigs"]>[number] | undefined {
    return this.options.host.registry()?.publicationConfigs().find((publication) => publication.id === id);
  }

  private toView(entry: PublicationConfig & { revision?: string }, roots: CatalogRoot[]): A2aPublicationView {
    const { inputSchema: _input, outputSchema: _output, ...config } = entry as typeof entry & { inputSchema?: unknown; outputSchema?: unknown };
    const root = roots.find((candidate) => sameFile(candidate.path, entry.project_root));
    const relative = (file: string): string =>
      path.isAbsolute(file) && isInsideProjectRoot(entry.project_root, file)
        ? path.relative(entry.project_root, file).replace(/\\/g, "/")
        : path.isAbsolute(file)
          ? OUTSIDE_PROJECT
          : file;
    return {
      ...config,
      ...(root ? {} : { root_unmanaged: true as const }),
      project_root: root?.project_root ?? "",
      pipeline: relative(entry.pipeline),
      input_schema: relative(entry.input_schema),
    };
  }
}

function real(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function sameFile(a: string, b: string): boolean {
  return real(a) === real(b);
}

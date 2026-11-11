import { access, mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import {
  attachmentIssuesFromFiles,
  findFunctionUsages,
  FUNCTION_CONTRACT_VERSION,
  functionFilePath,
  functionSourceHash,
  hashText,
  isFunctionDefinitionFile,
  parseFunctionDefinition,
  parseFunctionYaml,
  sameFunctionDefinition,
  serializeFunctionDefinition,
  type FunctionDefinition,
  type FunctionIssue,
  type FunctionKind,
  type FunctionUsage,
  type FunctionUse,
} from "../config/loadFunction.js";
import { writeFileAtomic } from "../config/atomicWrite.js";
import {
  agentProjectKey,
  FunctionStore,
  type FunctionPin,
  type FunctionRevision,
  type FunctionRevisionMeta,
  type FunctionRevisionSource,
} from "./store.js";

export type FunctionActor = { source: FunctionRevisionSource; author?: string | null };

export type FunctionErrorCode =
  | "function.invalid"
  | "function.not_found"
  | "function.exists"
  | "function.conflict"
  | "function.kind_immutable"
  | "function.id_immutable"
  | "function.in_use"
  | "function.catalog_unreadable"
  | "function.revision_not_found";

const STATUS: Partial<Record<FunctionErrorCode, number>> = {
  "function.invalid": 422,
  "function.kind_immutable": 422,
  "function.id_immutable": 422,
  "function.not_found": 404,
  "function.revision_not_found": 404,
  "function.exists": 409,
  "function.conflict": 409,
  "function.in_use": 409,
  "function.catalog_unreadable": 409,
};

export class FunctionError extends Error {
  readonly issues: FunctionIssue[];
  readonly currentRevision?: number;
  readonly usages?: FunctionUsage[];

  constructor(
    readonly code: FunctionErrorCode,
    message?: string,
    options: { issues?: FunctionIssue[]; currentRevision?: number; usages?: FunctionUsage[] } = {},
  ) {
    super(message ?? code);
    this.name = "FunctionError";
    this.issues = options.issues ?? [];
    if (options.currentRevision !== undefined) this.currentRevision = options.currentRevision;
    if (options.usages !== undefined) this.usages = options.usages;
  }

  get httpStatus(): number {
    return STATUS[this.code] ?? 400;
  }
}

export function isFunctionError(error: unknown): error is FunctionError {
  return error instanceof FunctionError;
}

export type FunctionSummary = {
  id: string;
  name: string | null;
  description: string | null;
  kind: FunctionKind | null;
  revision: number;
  issues: FunctionIssue[];
  updatedAt: string;
};

export type FunctionDetail = {
  id: string;
  name: string | null;
  description: string | null;
  kind: FunctionKind | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  issues: FunctionIssue[];
  definition: FunctionDefinition | null;
  yaml: string | null;
  sourceHash: string | null;
  contractVersion: number | null;
};

export class FunctionService {
  private readonly store: FunctionStore;
  private readonly now: () => Date;
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(options: { store: FunctionStore; now?: () => Date }) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
  }

  private iso(): string {
    return this.now().toISOString();
  }

  private exclusive<T>(projectRoot: string, work: () => Promise<T>): Promise<T> {
    const key = path.resolve(projectRoot);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    this.tails.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async sync(projectRoot: string): Promise<void> {
    const projectKey = agentProjectKey(projectRoot);
    const directory = path.join(projectRoot, "functions");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      names = [];
    }
    const seen = new Set<string>();
    for (const name of names.sort()) {
      if (!isFunctionDefinitionFile(name) || !name.endsWith(".function.yaml")) continue;
      const functionId = name.slice(0, -".function.yaml".length);
      seen.add(functionId);
      const text = await readFile(path.join(directory, name), "utf8");
      const fileHash = hashText(text);
      const row = this.store.getDefinition(projectKey, functionId);
      if (row && row.fileHash === fileHash && !row.deleted) continue;
      this.applyFile(projectKey, functionId, text, fileHash, row);
    }
    for (const row of this.store.listDefinitions(projectKey)) {
      if (!seen.has(row.functionId) && !row.deleted) {
        this.store.updateDefinitionState(projectKey, row.functionId, { deleted: true, fileHash: null, issues: [] }, this.iso());
      }
    }
  }

  private applyFile(
    projectKey: string,
    functionId: string,
    text: string,
    fileHash: string,
    row: ReturnType<FunctionStore["getDefinition"]>,
  ): void {
    const now = this.iso();
    const parsed = parseFunctionYaml(text);
    const issues = !parsed.ok
      ? parsed.issues
      : parsed.value.id !== functionId
        ? [{ path: "id", code: "function.id_mismatch", message: `id must match the file name (${functionId})` }]
        : [];
    if (!parsed.ok || issues.length > 0) {
      if (!row) this.store.recordInvalid(projectKey, functionId, fileHash, issues, now);
      else this.store.updateDefinitionState(projectKey, functionId, { fileHash, issues, deleted: false }, now);
      return;
    }
    const current = row && row.currentRevision > 0 ? this.store.getRevision(projectKey, functionId, row.currentRevision) : undefined;
    if (current && current.definition.kind !== parsed.value.kind) {
      this.store.updateDefinitionState(
        projectKey,
        functionId,
        {
          fileHash,
          deleted: false,
          issues: [{ path: "kind", code: "function.kind_immutable", message: "Kind cannot change in place" }],
        },
        now,
      );
      return;
    }
    if (current && sameFunctionDefinition(current.definition, parsed.value)) {
      this.store.updateDefinitionState(projectKey, functionId, { fileHash, issues: [], deleted: false }, now);
      return;
    }
    this.store.appendRevision(projectKey, {
      definition: parsed.value,
      yaml: text,
      sourceHash: functionSourceHash(parsed.value.source),
      contractVersion: FUNCTION_CONTRACT_VERSION,
      source: "file",
      summary: current ? "Edited outside the console" : "Added outside the console",
      fileHash,
      now,
    });
  }

  private detail(projectRoot: string, functionId: string): FunctionDetail {
    const projectKey = agentProjectKey(projectRoot);
    const row = this.store.getDefinition(projectKey, functionId);
    if (!row || row.deleted) throw new FunctionError("function.not_found");
    const revision = row.currentRevision > 0 ? this.store.getRevision(projectKey, functionId, row.currentRevision) : undefined;
    const runnable = row.issues.length === 0 && revision !== undefined;
    const definition = runnable ? revision.definition : null;
    return {
      id: functionId,
      name: definition?.name ?? revision?.definition.name ?? null,
      description: definition?.description ?? null,
      kind: definition?.kind ?? revision?.definition.kind ?? null,
      revision: row.currentRevision,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      issues: row.issues,
      definition,
      yaml: runnable ? revision.yaml : null,
      sourceHash: runnable ? revision.sourceHash : null,
      contractVersion: runnable ? revision.contractVersion : null,
    };
  }

  private async writeRevision(
    projectRoot: string,
    definition: FunctionDefinition,
    actor: FunctionActor,
    summary: string | null,
  ): Promise<void> {
    const yaml = serializeFunctionDefinition(definition);
    const target = functionFilePath(projectRoot, definition.id);
    await writeFileAtomic(target, yaml);
    this.store.appendRevision(agentProjectKey(projectRoot), {
      definition,
      yaml,
      sourceHash: functionSourceHash(definition.source),
      contractVersion: FUNCTION_CONTRACT_VERSION,
      source: actor.source,
      author: actor.author ?? null,
      summary,
      fileHash: hashText(yaml),
      now: this.iso(),
    });
  }

  private parseOrThrow(raw: unknown): FunctionDefinition {
    const parsed = parseFunctionDefinition(raw);
    if (!parsed.ok) throw new FunctionError("function.invalid", "Function definition is invalid", { issues: parsed.issues });
    return parsed.value;
  }

  async create(projectRoot: string, raw: unknown, actor: FunctionActor): Promise<FunctionDetail> {
    const definition = this.parseOrThrow(raw);
    await this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const row = this.store.getDefinition(agentProjectKey(projectRoot), definition.id);
      let onDisk = false;
      try {
        await access(functionFilePath(projectRoot, definition.id));
        onDisk = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (onDisk || (row && !row.deleted)) throw new FunctionError("function.exists", `A function with id "${definition.id}" already exists`);
      await mkdir(path.join(projectRoot, "functions"), { recursive: true });
      await this.writeRevision(projectRoot, definition, actor, "Created");
    });
    return this.get(projectRoot, definition.id);
  }

  async save(
    projectRoot: string,
    functionId: string,
    input: { baseRevision: number; definition: unknown; summary?: string | null },
    actor: FunctionActor,
  ): Promise<FunctionDetail> {
    const definition = this.parseOrThrow(input.definition);
    if (definition.id !== functionId) {
      throw new FunctionError("function.id_immutable", "The id cannot change", {
        issues: [{ path: "id", code: "function.id_immutable", message: "The id is fixed after creation" }],
      });
    }
    await this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const projectKey = agentProjectKey(projectRoot);
      const row = this.store.getDefinition(projectKey, functionId);
      if (!row || row.deleted || row.currentRevision === 0) throw new FunctionError("function.not_found");
      if (row.currentRevision !== input.baseRevision) {
        throw new FunctionError("function.conflict", "The function changed since it was loaded", { currentRevision: row.currentRevision });
      }
      const current = this.store.getRevision(projectKey, functionId, row.currentRevision);
      if (!current) throw new FunctionError("function.revision_not_found");
      if (current.definition.kind !== definition.kind) {
        throw new FunctionError("function.kind_immutable", "Kind cannot change in place", {
          issues: [{ path: "kind", code: "function.kind_immutable", message: "Kind cannot change in place" }],
        });
      }
      if (sameFunctionDefinition(current.definition, definition)) return;
      await this.writeRevision(projectRoot, definition, actor, input.summary?.trim() || null);
    });
    return this.get(projectRoot, functionId);
  }

  async duplicate(projectRoot: string, functionId: string, input: { id: string }, actor: FunctionActor): Promise<FunctionDetail> {
    await this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const current = this.detail(projectRoot, functionId);
      if (!current.definition) {
        throw new FunctionError("function.invalid", "Fix the function file before duplicating it", { issues: current.issues });
      }
      const definition = this.parseOrThrow({ ...current.definition, id: input.id });
      const row = this.store.getDefinition(agentProjectKey(projectRoot), definition.id);
      if (row && !row.deleted) throw new FunctionError("function.exists", `A function with id "${definition.id}" already exists`);
      await mkdir(path.join(projectRoot, "functions"), { recursive: true });
      await this.writeRevision(projectRoot, definition, actor, `Duplicated from ${functionId}`);
    });
    return this.get(projectRoot, input.id);
  }

  async delete(projectRoot: string, functionId: string): Promise<{ deleted: true }> {
    await this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const row = this.store.getDefinition(agentProjectKey(projectRoot), functionId);
      if (!row || row.deleted) throw new FunctionError("function.not_found");
      const usages = await findFunctionUsages(projectRoot, functionId);
      if (!usages.ok) throw new FunctionError("function.catalog_unreadable", usages.message);
      if (usages.usages.length > 0) {
        throw new FunctionError("function.in_use", "The function is still referenced", { usages: usages.usages });
      }
      await rm(functionFilePath(projectRoot, functionId), { force: true });
      this.store.updateDefinitionState(agentProjectKey(projectRoot), functionId, { deleted: true, fileHash: null, issues: [] }, this.iso());
    });
    return { deleted: true };
  }

  async get(projectRoot: string, functionId: string): Promise<FunctionDetail> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      return this.detail(projectRoot, functionId);
    });
  }

  async list(projectRoot: string): Promise<FunctionSummary[]> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      return this.store
        .listDefinitions(agentProjectKey(projectRoot))
        .filter((row) => !row.deleted)
        .map((row) => {
          const revision = row.currentRevision > 0 ? this.store.getRevision(agentProjectKey(projectRoot), row.functionId, row.currentRevision) : undefined;
          const runnable = row.issues.length === 0 && revision !== undefined;
          return {
            id: row.functionId,
            name: runnable ? revision.definition.name : (revision?.definition.name ?? null),
            description: runnable ? (revision.definition.description ?? null) : null,
            kind: runnable ? revision.definition.kind : (revision?.definition.kind ?? null),
            revision: row.currentRevision,
            issues: row.issues,
            updatedAt: row.updatedAt,
          };
        });
    });
  }

  async listRevisions(projectRoot: string, functionId: string): Promise<FunctionRevisionMeta[]> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      if (!this.store.getDefinition(agentProjectKey(projectRoot), functionId)) throw new FunctionError("function.not_found");
      return this.store.listRevisions(agentProjectKey(projectRoot), functionId);
    });
  }

  async getRevision(projectRoot: string, functionId: string, revision: number): Promise<FunctionRevision> {
    const found = this.store.getRevision(agentProjectKey(projectRoot), functionId, revision);
    if (!found) throw new FunctionError("function.revision_not_found");
    return found;
  }

  async attachmentIssues(projectRoot: string, uses: readonly FunctionUse[]): Promise<FunctionIssue[]> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      return attachmentIssuesFromFiles(projectRoot, uses);
    });
  }

  async pinRun(projectRoot: string, runId: string, functionIds: readonly string[]): Promise<FunctionPin[]> {
    return this.pin(projectRoot, "run", runId, functionIds);
  }

  async pinSession(projectRoot: string, sessionId: string, functionIds: readonly string[]): Promise<FunctionPin[]> {
    return this.pin(projectRoot, "session", sessionId, functionIds);
  }

  private async pin(
    projectRoot: string,
    scope: "run" | "session",
    scopeId: string,
    functionIds: readonly string[],
  ): Promise<FunctionPin[]> {
    return this.exclusive(projectRoot, async () => {
      await this.sync(projectRoot);
      const projectKey = agentProjectKey(projectRoot);
      const pins: FunctionPin[] = [];
      for (const functionId of functionIds) {
        const row = this.store.getDefinition(projectKey, functionId);
        if (!row || row.deleted || row.currentRevision === 0) throw new FunctionError("function.not_found", `Function "${functionId}" was not found`);
        if (row.issues.length > 0) {
          throw new FunctionError("function.invalid", `Function "${functionId}" cannot be pinned`, { issues: row.issues });
        }
        const revision = this.store.getRevision(projectKey, functionId, row.currentRevision);
        if (!revision) throw new FunctionError("function.revision_not_found");
        const pin: FunctionPin = {
          scope,
          scopeId,
          functionId,
          revision: revision.revision,
          sourceHash: revision.sourceHash,
          contractVersion: revision.contractVersion,
          pinnedAt: this.iso(),
        };
        this.store.upsertPin(projectKey, pin, pin.pinnedAt);
        pins.push(pin);
      }
      return pins;
    });
  }

  async getPin(
    projectRoot: string,
    scope: "run" | "session",
    scopeId: string,
    functionId: string,
  ): Promise<FunctionPin | undefined> {
    return this.store.getPin(agentProjectKey(projectRoot), scope, scopeId, functionId);
  }
}

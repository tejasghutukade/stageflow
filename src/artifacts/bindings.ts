import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parseAgentYaml } from "../config/loadAgent.js";
import {
  parseFunctionAttachment,
  type FunctionDefinition,
  type FunctionGrant,
} from "../config/loadFunction.js";
import { loadStageflowManifestOutcome } from "../config/loadStageflowManifest.js";
import { isExcluded, scanCatalogPaths } from "../config/scanCatalogPaths.js";
import type { LoadedManifest } from "../types/stageflowManifest.js";
import { payloadInstanceMismatch } from "../envelope/payloadSchema.js";
import { readFunctionDefinitionSync } from "../functions/toolPolicy.js";
import type { LiveBinding } from "./manifest.js";
import { ArtifactPublishError, type ArtifactIssue } from "./limits.js";
import type { ArtifactOwner } from "./record.js";

const READ_METHODS = new Set(["GET", "HEAD"]);

const TRANSIENT_FS_CODES = new Set([
  "ENOENT",
  "EBUSY",
  "EAGAIN",
  "EPERM",
  "EACCES",
  "EMFILE",
  "ENFILE",
  "EIO",
  "ETIMEDOUT",
  "EWOULDBLOCK",
  "UNKNOWN",
  "EBADF",
]);

function fsCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return undefined;
}

type ReadText = { ok: true; text: string } | { ok: false; missing: boolean; message: string };

let catalogReadForTests: ((file: string) => Promise<string>) | undefined;

export function setBindingCatalogReadForTests(read: ((file: string) => Promise<string>) | undefined): void {
  catalogReadForTests = read;
}

async function readUtf8(file: string): Promise<string> {
  if (catalogReadForTests) return catalogReadForTests(file);
  return readFile(file, "utf8");
}

async function readTextRetry(file: string): Promise<ReadText> {
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { ok: true, text: await readUtf8(file) };
    } catch (error) {
      last = error;
      const code = fsCode(error);
      if (code && TRANSIENT_FS_CODES.has(code) && attempt === 0) continue;
      const missing = code === "ENOENT" || code === "ENOTDIR";
      return { ok: false, missing, message: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: false, missing: false, message: last instanceof Error ? last.message : String(last) };
}

function catalogUnavailable(detail: string): OwnerFunctionAccess {
  return {
    ok: false,
    code: "artifact.catalog_unavailable",
    status: 503,
    message: `Could not read the catalog (retry): ${detail}`,
  };
}

export type BindingFailure = {
  status: number;
  code: string;
  message: string;
  issues: ArtifactIssue[];
};

export function bindingFailure(code: string, pathName: string, message: string, status = 400): BindingFailure {
  return { status, code, message, issues: [{ path: pathName, message }] };
}

export function throwBinding(failure: BindingFailure): never {
  throw new ArtifactPublishError(failure.status, failure.code, failure.message, failure.issues);
}

export function loadCurrentFunction(projectRoot: string, functionId: string): FunctionDefinition | undefined {
  return readFunctionDefinitionSync(projectRoot, functionId);
}

export function readOnlyFailure(definition: FunctionDefinition): BindingFailure | undefined {
  for (const capability of definition.capabilities) {
    if (capability.type === "file" && capability.access === "write") {
      const where =
        capability.root === "artifacts"
          ? "artifacts write"
          : capability.root === "workspace" && capability.path === ""
            ? "workspace write"
            : "files write";
      return bindingFailure(
        "artifact.binding_not_read_only",
        `bindings.${definition.id}`,
        `Function ${definition.id} is not read-only: it grants ${where}`,
      );
    }
    if (capability.type === "api") {
      const methods = capability.methods.map((method) => method.toUpperCase());
      const readMethods = methods.every((method) => READ_METHODS.has(method));
      if (capability.effect !== "read" || !readMethods) {
        return bindingFailure(
          "artifact.binding_not_read_only",
          `bindings.${definition.id}`,
          `Function ${definition.id} is not read-only: network access must be effect read with GET or HEAD only`,
        );
      }
    }
  }
  return undefined;
}

export function functionIdentityFailure(definition: FunctionDefinition | undefined, functionId: string): BindingFailure | undefined {
  if (!definition || definition.kind !== "tool" || definition.id !== functionId) {
    return bindingFailure(
      "artifact.binding_unknown_function",
      "bindings.function",
      `Function ${functionId} does not exist or is not kind tool`,
    );
  }
  return undefined;
}

export function argsFailure(definition: FunctionDefinition, args: Record<string, unknown>, issuePath: string): BindingFailure | undefined {
  if (!definition.input_schema) return undefined;
  let mismatch: string | undefined;
  try {
    mismatch = payloadInstanceMismatch(args, definition.input_schema);
  } catch (error) {
    mismatch = error instanceof Error ? error.message : "schema rejected the arguments";
  }
  if (!mismatch) return undefined;
  const issues = mismatch.split("; ").filter((part) => part.length > 0).map((part) => {
    const match = /^payload(?:\.(\S+))?\s+([\s\S]*)$/.exec(part);
    if (!match) return { path: issuePath, message: part };
    const suffix = match[1] ? `.${match[1]}` : "";
    return { path: `${issuePath}${suffix}`, message: match[2] || part };
  });
  return {
    status: 400,
    code: "artifact.binding_args_invalid",
    message: `Arguments for ${definition.id} do not match its input schema`,
    issues: issues.length > 0 ? issues : [{ path: issuePath, message: mismatch }],
  };
}

/**
 * Owner access for a live binding.
 *
 * Stage owners are read from catalog pipeline YAML (`loadStageflowManifestOutcome` and
 * `scanCatalogPaths`, including `uses:`). This does not call `loadPipeline`.
 * When several files in the same project declare one pipeline id, only the first
 * non-excluded path in catalog order is that pipeline. A later file does not grant access.
 * A `uses:` file that cannot be parsed is skipped with a warning and does not grant.
 * A catalog file that cannot be read is retried once. If the read still fails, the result is
 * `artifact.catalog_unavailable` (503), not a missing pipeline.
 * Grants are the attachment's `grants` list (`[]` when the list is omitted). Refresh passes
 * those grants and no others.
 */
export type OwnerFunctionAccess =
  | { ok: true; grants: FunctionGrant[] }
  | { ok: false; message: string; code?: "artifact.catalog_unavailable"; status?: number };

export async function ownerFunctionAccess(
  projectRoot: string,
  owner: ArtifactOwner,
  functionId: string,
): Promise<OwnerFunctionAccess> {
  if (owner.kind === "agent") return agentFunctionAccess(projectRoot, owner.agent, functionId);
  if (owner.kind === "guide") return { ok: false, message: "Guide artifacts do not attach functions" };
  return stageFunctionAccess(projectRoot, owner.pipeline, owner.stage, functionId);
}

async function agentFunctionAccess(projectRoot: string, agentId: string, functionId: string): Promise<OwnerFunctionAccess> {
  const read = await readTextRetry(path.join(projectRoot, "agents", `${agentId}.agent.yaml`));
  if (!read.ok) {
    if (!read.missing) return catalogUnavailable(read.message);
    return { ok: false, message: `Agent ${agentId} was not found` };
  }
  const text = read.text;
  const parsed = parseAgentYaml(text);
  if (!parsed.ok || parsed.value.id !== agentId) {
    return { ok: false, message: `Agent ${agentId} was not found` };
  }
  const attachment = (parsed.value.tools.functions ?? []).find((item) => item.id === functionId);
  if (!attachment) {
    return { ok: false, message: `Agent ${agentId} does not attach function ${functionId}` };
  }
  return { ok: true, grants: attachment.grants };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type AttachmentRead =
  | { state: "absent" }
  | { state: "invalid"; message: string }
  | { state: "present"; grants: FunctionGrant[] };

function attachmentRead(tools: unknown, functionId: string): AttachmentRead {
  if (!isRecord(tools) || !Array.isArray(tools.functions)) return { state: "absent" };
  for (const entry of tools.functions) {
    if (typeof entry === "string") {
      if (entry === functionId) return { state: "present", grants: [] };
      continue;
    }
    if (!isRecord(entry) || entry.id !== functionId) continue;
    if (entry.grants === undefined) return { state: "present", grants: [] };
    const parsed = parseFunctionAttachment(entry, "tools.functions");
    if (!parsed.ok) return { state: "invalid", message: parsed.message };
    return { state: "present", grants: parsed.value.grants };
  }
  return { state: "absent" };
}

async function stageBody(
  file: string,
  entry: Record<string, unknown>,
): Promise<{ skip: boolean; unavailable?: string; body: Record<string, unknown> }> {
  if (typeof entry.uses !== "string") return { skip: false, body: entry };
  const usedPath = path.resolve(path.dirname(file), entry.uses);
  const read = await readTextRetry(usedPath);
  if (!read.ok) {
    if (!read.missing) return { skip: true, unavailable: read.message, body: entry };
    console.warn(`artifact binding: skipped unreadable stage file ${usedPath}: ${read.message}`);
    return { skip: true, body: entry };
  }
  const text = read.text;
  let parsed: unknown;
  try {
    parsed = parseYaml(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`artifact binding: skipped unreadable stage file ${usedPath}: ${message}`);
    return { skip: true, body: entry };
  }
  if (!isRecord(parsed)) {
    console.warn(`artifact binding: skipped unreadable stage file ${usedPath}: stage file is not a mapping`);
    return { skip: true, body: entry };
  }
  return { skip: false, body: { ...parsed, ...entry, tools: entry.tools ?? parsed.tools } };
}

function pipelineNameMatches(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(name);
}

async function walkFiles(absDir: string): Promise<string[]> {
  const files: string[] = [];
  let entries;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      entries = await readdir(absDir, { withFileTypes: true, recursive: true });
      break;
    } catch (error) {
      const code = fsCode(error);
      if (code && TRANSIENT_FS_CODES.has(code) && attempt === 0) continue;
      return files;
    }
  }
  if (!entries) return files;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parentDir = entry.parentPath ?? absDir;
    files.push(path.join(parentDir, entry.name));
  }
  return files;
}

async function statRetry(absPath: string): Promise<{ found: boolean; unreadable?: string; isDirectory?: boolean; isFile?: boolean }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const entryStat = await stat(absPath);
      return { found: true, isDirectory: entryStat.isDirectory(), isFile: entryStat.isFile() };
    } catch (error) {
      const code = fsCode(error);
      if (code && TRANSIENT_FS_CODES.has(code) && attempt === 0) continue;
      const missing = code === "ENOENT" || code === "ENOTDIR";
      if (missing) return { found: false };
      return { found: false, unreadable: error instanceof Error ? error.message : String(error) };
    }
  }
  return { found: false, unreadable: "Could not stat catalog path" };
}

async function catalogPipelineFiles(loaded: LoadedManifest): Promise<{ included: string[]; excluded: string[]; unreadable?: string }> {
  const included = await scanCatalogPaths(loaded, "pipeline");
  const includedSet = new Set(included.map((file) => path.resolve(file)));
  const exclude = loaded.manifest.catalog.exclude;
  const excluded: string[] = [];
  let unreadable: string | undefined;
  if (!exclude || exclude.length === 0) return { included, excluded };
  const pattern = loaded.patterns.pipeline;
  for (const entry of loaded.manifest.catalog.pipelines) {
    const absPath = path.join(loaded.projectRoot, entry);
    const entryStat = await statRetry(absPath);
    if (entryStat.unreadable) unreadable = entryStat.unreadable;
    if (!entryStat.found) continue;
    const candidates = entryStat.isDirectory ? await walkFiles(absPath) : entryStat.isFile ? [absPath] : [];
    for (const file of candidates) {
      if (!pipelineNameMatches(path.basename(file), pattern)) continue;
      const normalized = path.resolve(file);
      if (includedSet.has(normalized)) continue;
      const repoRel = path.relative(loaded.projectRoot, normalized).replace(/\\/g, "/").replace(/^\.\/+/, "");
      if (!isExcluded(repoRel, exclude)) continue;
      excluded.push(normalized);
    }
  }
  excluded.sort((a, b) => a.localeCompare(b));
  return { included, excluded, unreadable };
}

function manifestAccessFailure(projectRoot: string, issues: { message: string }[]): OwnerFunctionAccess {
  const text = issues.map((issue) => issue.message).join("; ");
  if (text.includes("Manifest not found") || text.includes(path.join(projectRoot, "stageflow.yaml"))) {
    return { ok: false, message: "Project has no stageflow.yaml" };
  }
  if (text.includes("pipelines")) return { ok: false, message: "Manifest has no catalog.pipelines" };
  return { ok: false, message: `Project manifest could not be read: ${text || "invalid manifest"}` };
}

type PipelineFile = { file: string; id?: string; text: string };

type CatalogSnapshot = {
  failure?: OwnerFunctionAccess;
  included: PipelineFile[];
  excludedIds: Set<string>;
  unreadable?: string;
};

type CatalogMemo = { depth: number; snapshot?: Promise<CatalogSnapshot> };

const catalogMemos = new Map<string, CatalogMemo>();
const catalogInflight = new Map<string, Promise<CatalogSnapshot>>();

function retainCatalog(projectRoot: string): () => void {
  const slot = catalogMemos.get(projectRoot) ?? { depth: 0 };
  slot.depth += 1;
  catalogMemos.set(projectRoot, slot);
  return () => {
    slot.depth -= 1;
    if (slot.depth <= 0) catalogMemos.delete(projectRoot);
  };
}

async function readPipelineFile(file: string): Promise<{ file: PipelineFile } | { unavailable: string } | { skip: true }> {
  const read = await readTextRetry(file);
  if (!read.ok) {
    if (read.missing) return { skip: true };
    return { unavailable: read.message };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(read.text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`artifact binding: skipped unreadable pipeline file ${file}: ${message}`);
    return { skip: true };
  }
  if (!isRecord(parsed) || typeof parsed.id !== "string") return { file: { file, text: read.text } };
  return { file: { file, id: parsed.id, text: read.text } };
}

async function buildCatalogSnapshot(projectRoot: string): Promise<CatalogSnapshot> {
  const manifest = await loadStageflowManifestOutcome(projectRoot);
  if (!manifest.ok) return { failure: manifestAccessFailure(projectRoot, manifest.issues), included: [], excludedIds: new Set() };
  if (manifest.value.manifest.catalog.pipelines.length === 0) {
    return {
      failure: { ok: false, message: "Manifest has no catalog.pipelines" },
      included: [],
      excludedIds: new Set(),
    };
  }
  const { included, excluded, unreadable } = await catalogPipelineFiles(manifest.value);
  const files: PipelineFile[] = [];
  const excludedIds = new Set<string>();
  let readError = unreadable;
  for (const file of excluded) {
    const read = await readPipelineFile(file);
    if ("unavailable" in read) readError = read.unavailable;
    else if ("file" in read && read.file.id) excludedIds.add(read.file.id);
  }
  for (const file of included) {
    const read = await readPipelineFile(file);
    if ("unavailable" in read) readError = read.unavailable;
    else if ("file" in read) files.push(read.file);
  }
  return { included: files, excludedIds, unreadable: readError };
}

async function catalogSnapshot(projectRoot: string): Promise<CatalogSnapshot> {
  const slot = catalogMemos.get(projectRoot);
  if (slot?.snapshot) return slot.snapshot;
  const existing = catalogInflight.get(projectRoot);
  if (existing) {
    if (slot) slot.snapshot = existing;
    return existing;
  }
  let resolvePending: (value: CatalogSnapshot) => void = () => undefined;
  let rejectPending: (error: unknown) => void = () => undefined;
  const pending = new Promise<CatalogSnapshot>((resolve, reject) => {
    resolvePending = resolve;
    rejectPending = reject;
  });
  catalogInflight.set(projectRoot, pending);
  if (slot) slot.snapshot = pending;
  void buildCatalogSnapshot(projectRoot).then(resolvePending, rejectPending).finally(() => {
    if (catalogInflight.get(projectRoot) === pending) catalogInflight.delete(projectRoot);
  });
  return pending;
}

async function stageFunctionAccess(
  projectRoot: string,
  pipelineId: string,
  stageId: string,
  functionId: string,
): Promise<OwnerFunctionAccess> {
  const snapshot = await catalogSnapshot(projectRoot);
  if (snapshot.failure) return snapshot.failure;
  const matches = snapshot.included.filter((file) => file.id === pipelineId);
  if (matches.length === 0) {
    if (snapshot.excludedIds.has(pipelineId)) {
      return { ok: false, message: `Pipeline ${pipelineId} is excluded from the catalog` };
    }
    if (snapshot.unreadable) return catalogUnavailable(snapshot.unreadable);
    return { ok: false, message: `Pipeline ${pipelineId} was not found in the catalog` };
  }
  const matching = matches[0]!;
  const relative = path.relative(projectRoot, matching.file).replace(/\\/g, "/");
  const found = await stageGrantInFile(matching.file, stageId, functionId, matching.text);
  if (found.state === "unavailable") return catalogUnavailable(found.message);
  if (found.state === "invalid") {
    return { ok: false, message: `Stage ${stageId} on pipeline ${pipelineId} could not be read: ${found.message}` };
  }
  if (found.state === "present") return { ok: true, grants: found.grants };
  if (matches.length > 1) {
    return {
      ok: false,
      message: `Pipeline ${pipelineId} is declared in more than one catalog file; only ${relative} is the pipeline for this project, and stage ${stageId} on that file does not attach function ${functionId}`,
    };
  }
  if (found.state === "no-stage") {
    return { ok: false, message: `Stage ${stageId} was not found on pipeline ${pipelineId}` };
  }
  return {
    ok: false,
    message: `Stage ${stageId} on pipeline ${pipelineId} does not attach function ${functionId}`,
  };
}

async function stageGrantInFile(
  file: string,
  stageId: string,
  functionId: string,
  text?: string,
): Promise<AttachmentRead | { state: "no-stage" } | { state: "unavailable"; message: string }> {
  let source = text;
  if (source === undefined) {
    const read = await readTextRetry(file);
    if (!read.ok) {
      if (read.missing) return { state: "no-stage" };
      return { state: "unavailable", message: read.message };
    }
    source = read.text;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(source) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`artifact binding: skipped unreadable pipeline file ${file}: ${message}`);
    return { state: "no-stage" };
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.stages)) return { state: "no-stage" };
  let invalid: AttachmentRead | undefined;
  let sawStage = false;
  for (const raw of parsed.stages) {
    if (!isRecord(raw)) continue;
    const loaded = await stageBody(file, raw);
    if (loaded.unavailable) {
      const skippedId = typeof raw.id === "string" ? raw.id : "";
      if (skippedId === stageId) return { state: "unavailable", message: loaded.unavailable };
      console.warn(`artifact binding: skipped unreadable stage file for ${skippedId || "a stage"}: ${loaded.unavailable}`);
      continue;
    }
    if (loaded.skip) {
      const skippedId = typeof raw.id === "string" ? raw.id : "";
      if (skippedId === stageId) {
        return { state: "invalid", message: `the stage file used by ${stageId} could not be parsed` };
      }
      continue;
    }
    const id = typeof raw.id === "string" ? raw.id : typeof loaded.body.id === "string" ? loaded.body.id : "";
    if (id !== stageId) continue;
    sawStage = true;
    const read = attachmentRead(loaded.body.tools, functionId);
    if (read.state === "present") return read;
    if (read.state === "invalid") invalid = read;
  }
  if (invalid) return invalid;
  return sawStage ? { state: "absent" } : { state: "no-stage" };
}

export type BindingCheck = {
  failure?: BindingFailure;
  grants: FunctionGrant[];
};

export async function checkBinding(
  projectRoot: string,
  owner: ArtifactOwner,
  binding: LiveBinding,
  index: number,
  definition?: FunctionDefinition,
): Promise<BindingCheck> {
  const loaded = definition ?? loadCurrentFunction(projectRoot, binding.function);
  const identity = functionIdentityFailure(loaded, binding.function);
  if (identity) {
    return {
      failure: { ...identity, issues: identity.issues.map((issue) => ({ ...issue, path: `manifest.bindings[${index}].function` })) },
      grants: [],
    };
  }
  const access = await ownerFunctionAccess(projectRoot, owner, binding.function);
  if (!access.ok) {
    return {
      failure: bindingFailure(
        access.code ?? "artifact.binding_not_granted",
        `manifest.bindings[${index}].function`,
        access.message,
        access.status ?? 400,
      ),
      grants: [],
    };
  }
  const readOnly = readOnlyFailure(loaded!);
  if (readOnly) {
    return {
      failure: { ...readOnly, issues: [{ path: `manifest.bindings[${index}].function`, message: readOnly.message }] },
      grants: access.grants,
    };
  }
  return {
    failure: argsFailure(loaded!, binding.args, `manifest.bindings[${index}].args`),
    grants: access.grants,
  };
}

export async function assertBindingsAtPublish(
  projectRoot: string,
  owner: ArtifactOwner,
  bindings: readonly LiveBinding[],
): Promise<void> {
  const release = retainCatalog(projectRoot);
  try {
    const issues: ArtifactIssue[] = [];
    let failure: BindingFailure | undefined;
    for (let index = 0; index < bindings.length; index += 1) {
      const result = await checkBinding(projectRoot, owner, bindings[index]!, index);
      if (!result.failure) continue;
      failure = failure ?? result.failure;
      issues.push(...result.failure.issues);
    }
    if (failure) {
      throw new ArtifactPublishError(failure.status, failure.code, failure.message, issues);
    }
  } finally {
    release();
  }
}

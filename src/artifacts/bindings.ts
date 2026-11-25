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
 * A `uses:` file that cannot be read or parsed is skipped with a warning and does not grant.
 * Grants are the attachment's `grants` list (`[]` when the list is omitted). Refresh passes
 * those grants and no others.
 */
export type OwnerFunctionAccess =
  | { ok: true; grants: FunctionGrant[] }
  | { ok: false; message: string };

export async function ownerFunctionAccess(
  projectRoot: string,
  owner: ArtifactOwner,
  functionId: string,
): Promise<OwnerFunctionAccess> {
  if (owner.kind === "agent") return agentFunctionAccess(projectRoot, owner.agent, functionId);
  return stageFunctionAccess(projectRoot, owner.pipeline, owner.stage, functionId);
}

async function agentFunctionAccess(projectRoot: string, agentId: string, functionId: string): Promise<OwnerFunctionAccess> {
  let text: string;
  try {
    text = await readFile(path.join(projectRoot, "agents", `${agentId}.agent.yaml`), "utf8");
  } catch {
    return { ok: false, message: `Agent ${agentId} was not found` };
  }
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
): Promise<{ skip: boolean; body: Record<string, unknown> }> {
  if (typeof entry.uses !== "string") return { skip: false, body: entry };
  const usedPath = path.resolve(path.dirname(file), entry.uses);
  let text: string;
  try {
    text = await readFile(usedPath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`artifact binding: skipped unreadable stage file ${usedPath}: ${message}`);
    return { skip: true, body: entry };
  }
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
  try {
    entries = await readdir(absDir, { withFileTypes: true, recursive: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parentDir = entry.parentPath ?? absDir;
    files.push(path.join(parentDir, entry.name));
  }
  return files;
}

async function catalogPipelineFiles(loaded: LoadedManifest): Promise<{ included: string[]; excluded: string[] }> {
  const included = await scanCatalogPaths(loaded, "pipeline");
  const includedSet = new Set(included.map((file) => path.resolve(file)));
  const exclude = loaded.manifest.catalog.exclude;
  const excluded: string[] = [];
  if (!exclude || exclude.length === 0) return { included, excluded };
  const pattern = loaded.patterns.pipeline;
  for (const entry of loaded.manifest.catalog.pipelines) {
    const absPath = path.join(loaded.projectRoot, entry);
    let entryStat;
    try {
      entryStat = await stat(absPath);
    } catch {
      continue;
    }
    const candidates = entryStat.isDirectory() ? await walkFiles(absPath) : entryStat.isFile() ? [absPath] : [];
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
  return { included, excluded };
}

function manifestAccessFailure(projectRoot: string, issues: { message: string }[]): OwnerFunctionAccess {
  const text = issues.map((issue) => issue.message).join("; ");
  if (text.includes("Manifest not found") || text.includes(path.join(projectRoot, "stageflow.yaml"))) {
    return { ok: false, message: "Project has no stageflow.yaml" };
  }
  if (text.includes("pipelines")) return { ok: false, message: "Manifest has no catalog.pipelines" };
  return { ok: false, message: `Project manifest could not be read: ${text || "invalid manifest"}` };
}

async function stageFunctionAccess(
  projectRoot: string,
  pipelineId: string,
  stageId: string,
  functionId: string,
): Promise<OwnerFunctionAccess> {
  const manifest = await loadStageflowManifestOutcome(projectRoot);
  if (!manifest.ok) return manifestAccessFailure(projectRoot, manifest.issues);
  if (manifest.value.manifest.catalog.pipelines.length === 0) {
    return { ok: false, message: "Manifest has no catalog.pipelines" };
  }
  const { included, excluded } = await catalogPipelineFiles(manifest.value);
  const matches: string[] = [];
  let excludedHit = false;
  for (const file of excluded) {
    const id = await pipelineIdOf(file);
    if (id === pipelineId) excludedHit = true;
  }
  for (const file of included) {
    const id = await pipelineIdOf(file);
    if (id === pipelineId) matches.push(file);
  }
  if (matches.length === 0) {
    if (excludedHit) return { ok: false, message: `Pipeline ${pipelineId} is excluded from the catalog` };
    return { ok: false, message: `Pipeline ${pipelineId} was not found in the catalog` };
  }
  const matching = matches[0]!;
  const relative = path.relative(projectRoot, matching).replace(/\\/g, "/");
  const found = await stageGrantInFile(matching, stageId, functionId);
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

async function pipelineIdOf(file: string): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`artifact binding: skipped unreadable pipeline file ${file}: ${message}`);
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.id !== "string") return undefined;
  return parsed.id;
}

async function stageGrantInFile(
  file: string,
  stageId: string,
  functionId: string,
): Promise<AttachmentRead | { state: "no-stage" }> {
  let parsed: unknown;
  try {
    parsed = parseYaml(await readFile(file, "utf8")) as unknown;
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
        "artifact.binding_not_granted",
        `manifest.bindings[${index}].function`,
        access.message,
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
}

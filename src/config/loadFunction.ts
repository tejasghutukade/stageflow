import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, cp, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml, YAMLParseError } from "yaml";
import { canonicalJson, sha256Hex } from "../evals/canonical.js";
import { loadStageflowManifestOutcome } from "./loadStageflowManifest.js";
import { isExcluded } from "./scanCatalogPaths.js";
import { yamlParsePosition } from "./yamlParsePosition.js";

export const FUNCTION_CONTRACT_VERSION = 1;
export const DEFAULT_FUNCTION_TIMEOUT_MS = 5000;
export const MAX_FUNCTION_TIMEOUT_MS = 30_000;
export const MAX_FUNCTION_SOURCE_BYTES = 64 * 1024;

const FUNCTION_ID = /^[a-z][a-z0-9_]{0,63}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9_]{0,63}$/;
const ENV_ALIAS = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CREDENTIAL_REF = /^[A-Za-z0-9_.:-]{1,128}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const EXPORT_DEFAULT = /export\s+default\s+(?:async\s+)?function\s+execute\s*\(/;
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", ".stageflow"]);

export type FunctionKind = "verification" | "routing" | "tool";
export type FunctionFileRoot = "artifacts" | "workspace";
export type FunctionFileAccess = "read" | "write";
export type FunctionApiEffect = "read" | "action";

export type FunctionIssue = {
  path: string;
  code: string;
  message: string;
  line?: number;
  column?: number;
};

export type FileCapability = {
  id: string;
  type: "file";
  root: FunctionFileRoot;
  path: string;
  access: FunctionFileAccess;
};

export type EnvCapability = {
  id: string;
  type: "env";
  alias: string;
};

export type ApiCapability = {
  id: string;
  type: "api";
  origin: string;
  methods: string[];
  path_prefix: string;
  effect: FunctionApiEffect;
  credential_ref?: string;
};

export type FunctionCapability = FileCapability | EnvCapability | ApiCapability;

export type FunctionBinding = {
  alias: string;
  required: boolean;
};

export type FunctionGrant = {
  id: string;
  origin?: string;
  methods?: string[];
  path_prefix?: string;
  credential_ref?: string;
  root?: FunctionFileRoot;
  path?: string;
};

export type FunctionDefinition = {
  id: string;
  name: string;
  description?: string;
  kind: FunctionKind;
  source: string;
  timeout_ms: number;
  capabilities: FunctionCapability[];
  bindings: FunctionBinding[];
  tool_name?: string;
  tool_description?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
};

export type FunctionUse = {
  kind: FunctionKind;
  id: string;
  grants: FunctionGrant[];
};

export type FunctionUsage = {
  kind: "pipeline" | "stage" | "agent";
  path: string;
};

export type FunctionParseResult =
  | { ok: true; value: FunctionDefinition }
  | { ok: false; issues: FunctionIssue[] };

function issue(pathName: string, code: string, message: string): FunctionIssue {
  return { path: pathName, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function relativePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (path.isAbsolute(trimmed)) return undefined;
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.split("/").includes("..")) return undefined;
  return normalized;
}

function sameStrings(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  const a = [...(left ?? [])].map((item) => item.toUpperCase()).sort();
  const b = [...(right ?? [])].map((item) => item.toUpperCase()).sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sourceIsExecutableShape(source: string): boolean {
  if (Buffer.byteLength(source, "utf8") > MAX_FUNCTION_SOURCE_BYTES) return false;
  if (!EXPORT_DEFAULT.test(source)) return false;
  const checked = spawnSync(process.execPath, ["--check", "--input-type=module"], {
    input: source,
    encoding: "utf8",
    timeout: 5000,
  });
  return checked.status === 0;
}

function schemaIssues(value: unknown, field: string): FunctionIssue[] {
  const issues: FunctionIssue[] = [];
  const walk = (node: unknown, nodePath: string, depth: number, root: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${nodePath}.${index}`, depth + 1, false));
      return;
    }
    if (!isRecord(node)) return;
    if (depth > 8) {
      issues.push(issue(nodePath, "function.schema_depth", "JSON schema is nested too deeply"));
      return;
    }
    const keys = Object.keys(node);
    if (keys.length > 64) {
      issues.push(issue(nodePath, "function.schema", "JSON schema has too many properties"));
      return;
    }
    if (root && node.type !== "object") {
      issues.push(issue(nodePath, "function.schema", "JSON schema root must be an object"));
    }
    for (const [key, child] of Object.entries(node)) walk(child, `${nodePath}.${key}`, depth + 1, false);
  };
  if (!isRecord(value)) {
    return [issue(field, "function.schema", "JSON schema root must be an object")];
  }
  walk(value, field, 0, true);
  return issues;
}

function parseMethods(value: unknown, field: string, issues: FunctionIssue[]): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    issues.push(issue(field, "function.invalid_methods", "Methods must be a non-empty list of HTTP methods"));
    return undefined;
  }
  const methods = value.map((item) => item.toUpperCase());
  if (new Set(methods).size !== methods.length || methods.some((method) => !HTTP_METHODS.has(method))) {
    issues.push(issue(field, "function.invalid_methods", "Methods must be unique GET, HEAD, POST, PUT, PATCH, or DELETE values"));
    return undefined;
  }
  return methods;
}

function parseOrigin(value: unknown, field: string, issues: FunctionIssue[]): string | undefined {
  if (typeof value !== "string") {
    issues.push(issue(field, "function.invalid_origin", "Origin must be an https URL"));
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    issues.push(issue(field, "function.invalid_origin", "Origin must be an https URL"));
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || (url.pathname !== "/" && url.pathname !== "")) {
    issues.push(issue(field, "function.invalid_origin", "Origin must be an https origin without a path or user info"));
    return undefined;
  }
  return url.origin;
}

function parseCapabilities(value: unknown, kind: FunctionKind, issues: FunctionIssue[]): FunctionCapability[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(issue("capabilities", "function.invalid_capabilities", "Capabilities must be a list"));
    return [];
  }
  const capabilities: FunctionCapability[] = [];
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    const field = `capabilities.${index}`;
    if (!isRecord(entry) || typeof entry.id !== "string" || !CAPABILITY_ID.test(entry.id)) {
      issues.push(issue(field, "function.invalid_capability", "A capability needs an id of lowercase letters, digits, and _"));
      return;
    }
    if (seen.has(entry.id)) {
      issues.push(issue(field, "function.duplicate_capability", `Capability ${entry.id} is listed twice`));
      return;
    }
    seen.add(entry.id);
    if (entry.type === "file") {
      const filePath = relativePath(entry.path);
      if ((entry.root !== "artifacts" && entry.root !== "workspace") || filePath === undefined) {
        issues.push(issue(field, "function.invalid_capability", "A file capability needs root artifacts or workspace and a relative path"));
        return;
      }
      if (entry.access !== "read" && entry.access !== "write") {
        issues.push(issue(field, "function.invalid_capability", "A file capability access must be read or write"));
        return;
      }
      if (entry.access === "write" && kind !== "tool") {
        issues.push(issue(field, "function.write_not_allowed", "Only a tool can write files"));
        return;
      }
      capabilities.push({ id: entry.id, type: "file", root: entry.root, path: filePath, access: entry.access });
      return;
    }
    if (entry.type === "env") {
      if (typeof entry.alias !== "string" || !ENV_ALIAS.test(entry.alias)) {
        issues.push(issue(field, "function.invalid_capability", "An env capability needs an alias"));
        return;
      }
      capabilities.push({ id: entry.id, type: "env", alias: entry.alias });
      return;
    }
    if (entry.type === "api") {
      const origin = parseOrigin(entry.origin, `${field}.origin`, issues);
      const methods = parseMethods(entry.methods, `${field}.methods`, issues);
      const prefix = typeof entry.path_prefix === "string" ? entry.path_prefix : undefined;
      if (origin === undefined || methods === undefined || prefix === undefined || !prefix.startsWith("/") || prefix.includes("..")) {
        if (prefix === undefined || !prefix.startsWith("/") || prefix.includes("..")) {
          issues.push(issue(`${field}.path_prefix`, "function.invalid_capability", "An API path prefix must start with / and stay relative"));
        }
        return;
      }
      if (entry.effect !== "read" && entry.effect !== "action") {
        issues.push(issue(field, "function.invalid_capability", "An API capability effect must be read or action"));
        return;
      }
      if (entry.effect === "action" && kind !== "tool") {
        issues.push(issue(field, "function.action_not_allowed", "Only a tool can call an API action"));
        return;
      }
      let credential: string | undefined;
      if (entry.credential_ref !== undefined) {
        if (typeof entry.credential_ref !== "string" || !CREDENTIAL_REF.test(entry.credential_ref)) {
          issues.push(issue(`${field}.credential_ref`, "function.invalid_capability", "A credential reference must name a stored credential"));
          return;
        }
        credential = entry.credential_ref;
      }
      capabilities.push({
        id: entry.id,
        type: "api",
        origin,
        methods,
        path_prefix: prefix,
        effect: entry.effect,
        ...(credential !== undefined ? { credential_ref: credential } : {}),
      });
      return;
    }
    issues.push(issue(field, "function.invalid_capability", "A capability type must be file, env, or api"));
  });
  return capabilities;
}

function parseBindings(value: unknown, capabilities: FunctionCapability[], issues: FunctionIssue[]): FunctionBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(issue("bindings", "function.invalid_bindings", "Bindings must be a list"));
    return [];
  }
  const aliases = new Set(capabilities.filter((capability) => capability.type === "env").map((capability) => capability.alias));
  const seen = new Set<string>();
  const bindings: FunctionBinding[] = [];
  value.forEach((entry, index) => {
    const field = `bindings.${index}`;
    if (!isRecord(entry) || typeof entry.alias !== "string" || !ENV_ALIAS.test(entry.alias)) {
      issues.push(issue(field, "function.invalid_binding", "A binding needs an alias"));
      return;
    }
    if (!aliases.has(entry.alias)) {
      issues.push(issue(field, "function.unknown_binding", `Binding ${entry.alias} does not match an env capability`));
      return;
    }
    if (seen.has(entry.alias)) {
      issues.push(issue(field, "function.duplicate_binding", `Binding ${entry.alias} is listed twice`));
      return;
    }
    seen.add(entry.alias);
    if (entry.required !== undefined && typeof entry.required !== "boolean") {
      issues.push(issue(field, "function.invalid_binding", "required must be a boolean"));
      return;
    }
    bindings.push({ alias: entry.alias, required: entry.required !== false });
  });
  return bindings;
}

export function parseFunctionDefinition(raw: unknown): FunctionParseResult {
  if (!isRecord(raw)) return { ok: false, issues: [issue("", "function.invalid_shape", "A function definition must be an object")] };
  const issues: FunctionIssue[] = [];
  if (typeof raw.id !== "string" || !FUNCTION_ID.test(raw.id)) {
    issues.push(issue("id", "function.invalid_id", "Id must use lowercase letters, digits, and _, starting with a letter"));
  }
  if (typeof raw.name !== "string" || raw.name.trim() === "" || raw.name.trim().length > 120) {
    issues.push(issue("name", "function.invalid_name", "Name is required"));
  }
  if (raw.description !== undefined && (typeof raw.description !== "string" || raw.description.trim().length > 500)) {
    issues.push(issue("description", "function.invalid_description", "Description must be 500 characters or fewer"));
  }
  if (raw.kind !== "verification" && raw.kind !== "routing" && raw.kind !== "tool") {
    issues.push(issue("kind", "function.invalid_kind", "Kind must be verification, routing, or tool"));
  }
  const kind: FunctionKind = raw.kind === "routing" || raw.kind === "tool" ? raw.kind : "verification";
  if (typeof raw.source !== "string" || raw.source.trim() === "") {
    issues.push(issue("source", "function.invalid_source", "Source is required"));
  } else if (!sourceIsExecutableShape(raw.source)) {
    issues.push(issue("source", "function.invalid_source", "Source must be a JavaScript module that exports default function execute"));
  }
  let timeout = DEFAULT_FUNCTION_TIMEOUT_MS;
  if (raw.timeout_ms !== undefined) {
    if (typeof raw.timeout_ms !== "number" || !Number.isInteger(raw.timeout_ms) || raw.timeout_ms < 1 || raw.timeout_ms > MAX_FUNCTION_TIMEOUT_MS) {
      issues.push(issue("timeout_ms", "function.invalid_timeout", `timeout_ms must be an integer from 1 to ${MAX_FUNCTION_TIMEOUT_MS}`));
    } else {
      timeout = raw.timeout_ms;
    }
  }
  const capabilities = parseCapabilities(raw.capabilities, kind, issues);
  const bindings = parseBindings(raw.bindings, capabilities, issues);
  const definition: FunctionDefinition = {
    id: typeof raw.id === "string" ? raw.id : "",
    name: typeof raw.name === "string" ? raw.name.trim() : "",
    ...(typeof raw.description === "string" && raw.description.trim() !== "" ? { description: raw.description.trim() } : {}),
    kind,
    source: typeof raw.source === "string" ? raw.source : "",
    timeout_ms: timeout,
    capabilities,
    bindings,
  };
  if (kind === "tool") {
    if (typeof raw.tool_name !== "string" || !TOOL_NAME.test(raw.tool_name)) {
      issues.push(issue("tool_name", "function.invalid_tool_name", "A tool needs a tool_name"));
    } else {
      definition.tool_name = raw.tool_name;
    }
    if (typeof raw.tool_description !== "string" || raw.tool_description.trim() === "") {
      issues.push(issue("tool_description", "function.invalid_tool_description", "A tool needs a tool_description"));
    } else {
      definition.tool_description = raw.tool_description.trim();
    }
    issues.push(...schemaIssues(raw.input_schema, "input_schema"));
    if (isRecord(raw.input_schema) && raw.input_schema.type === "object") definition.input_schema = raw.input_schema;
    if (raw.output_schema !== undefined) {
      issues.push(...schemaIssues(raw.output_schema, "output_schema"));
      if (isRecord(raw.output_schema) && raw.output_schema.type === "object") definition.output_schema = raw.output_schema;
    }
  } else if (raw.tool_name !== undefined || raw.tool_description !== undefined || raw.input_schema !== undefined || raw.output_schema !== undefined) {
    issues.push(issue("tool_name", "function.tool_fields", "Tool fields belong only on a tool"));
  }
  if (issues.length > 0 || definition.id === "" || definition.kind !== raw.kind) return { ok: false, issues };
  return { ok: true, value: definition };
}

export function sameFunctionDefinition(left: FunctionDefinition, right: FunctionDefinition): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function functionSourceHash(source: string): string {
  return sha256Hex(source);
}

export function serializeFunctionDefinition(definition: FunctionDefinition): string {
  const body: Record<string, unknown> = {
    id: definition.id,
    name: definition.name,
  };
  if (definition.description) body.description = definition.description;
  body.kind = definition.kind;
  body.source = definition.source;
  if (definition.timeout_ms !== DEFAULT_FUNCTION_TIMEOUT_MS) body.timeout_ms = definition.timeout_ms;
  if (definition.kind === "tool") {
    body.tool_name = definition.tool_name;
    body.tool_description = definition.tool_description;
    body.input_schema = definition.input_schema;
    if (definition.output_schema !== undefined) body.output_schema = definition.output_schema;
  }
  body.capabilities = definition.capabilities;
  body.bindings = definition.bindings;
  return stringifyYaml(body, { lineWidth: 0 });
}

export function functionFilePath(projectRoot: string, functionId: string): string {
  return path.join(projectRoot, "functions", `${functionId}.function.yaml`);
}

export function isFunctionDefinitionFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return base.endsWith(".function.yaml") || base.endsWith(".function.yml");
}

export function parseFunctionYaml(text: string): FunctionParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    const position = yamlParsePosition(error);
    return {
      ok: false,
      issues: [
        {
          path: "",
          code: "function.invalid_yaml",
          message: error instanceof YAMLParseError ? "Function YAML could not be parsed" : "Function YAML could not be parsed",
          ...position,
        },
      ],
    };
  }
  return parseFunctionDefinition(raw);
}

export async function readFunctionFile(
  projectRoot: string,
  functionId: string,
): Promise<{ missing: true } | { missing: false; text: string; parsed: FunctionParseResult }> {
  try {
    const text = await readFile(functionFilePath(projectRoot, functionId), "utf8");
    return { missing: false, text, parsed: parseFunctionYaml(text) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
    throw error;
  }
}

const GRANT_FIELDS = ["origin", "methods", "path_prefix", "credential_ref", "root", "path"] as const;

function grantHasForeignFields(grant: FunctionGrant, allowed: ReadonlySet<string>): boolean {
  return GRANT_FIELDS.some((field) => grant[field] !== undefined && !allowed.has(field));
}

function grantMatches(capability: FunctionCapability, grant: FunctionGrant): boolean {
  if (capability.type === "file") {
    if (grantHasForeignFields(grant, new Set(["root", "path"]))) return false;
    return grant.root === capability.root && grant.path === capability.path;
  }
  if (capability.type === "env") return !grantHasForeignFields(grant, new Set());
  if (grantHasForeignFields(grant, new Set(["origin", "methods", "path_prefix", "credential_ref"]))) return false;
  return (
    grant.origin === capability.origin &&
    grant.path_prefix === capability.path_prefix &&
    (grant.credential_ref ?? undefined) === (capability.credential_ref ?? undefined) &&
    sameStrings(grant.methods, capability.methods)
  );
}

export function parseFunctionGrant(raw: unknown, field: string): { ok: true; value: FunctionGrant } | { ok: false; message: string } {
  if (!isRecord(raw) || typeof raw.id !== "string" || !CAPABILITY_ID.test(raw.id)) {
    return { ok: false, message: `${field} needs a capability id` };
  }
  const grant: FunctionGrant = { id: raw.id };
  if (raw.origin !== undefined) {
    if (typeof raw.origin !== "string" || raw.origin.trim() === "") return { ok: false, message: `${field} origin must be a string` };
    grant.origin = raw.origin.trim();
  }
  if (raw.methods !== undefined) {
    if (!Array.isArray(raw.methods) || raw.methods.some((method) => typeof method !== "string" || method.trim() === "")) {
      return { ok: false, message: `${field} methods must be a list of strings` };
    }
    grant.methods = raw.methods.map((method) => method.trim());
  }
  if (raw.path_prefix !== undefined) {
    if (typeof raw.path_prefix !== "string" || raw.path_prefix.trim() === "") return { ok: false, message: `${field} path_prefix must be a string` };
    grant.path_prefix = raw.path_prefix.trim();
  }
  if (raw.credential_ref !== undefined) {
    if (typeof raw.credential_ref !== "string" || raw.credential_ref.trim() === "") {
      return { ok: false, message: `${field} credential_ref must be a string` };
    }
    grant.credential_ref = raw.credential_ref.trim();
  }
  if (raw.root !== undefined) {
    if (raw.root !== "artifacts" && raw.root !== "workspace") return { ok: false, message: `${field} root must be artifacts or workspace` };
    grant.root = raw.root;
  }
  if (raw.path !== undefined) {
    if (typeof raw.path !== "string" || raw.path.trim() === "") return { ok: false, message: `${field} path must be a string` };
    grant.path = raw.path.trim();
  }
  return { ok: true, value: grant };
}

export function parseFunctionGrants(raw: unknown, field: string): { ok: true; value: FunctionGrant[] } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, message: `${field} must be a list` };
  const grants: FunctionGrant[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index += 1) {
    const parsed = parseFunctionGrant(raw[index], `${field}[${index}]`);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value.id)) return { ok: false, message: `${field} grants ${parsed.value.id} twice` };
    seen.add(parsed.value.id);
    grants.push(parsed.value);
  }
  return { ok: true, value: grants };
}

export function parseStageFunctionTools(
  raw: unknown,
): { ok: true; value: { functions: Array<{ id: string; grants: FunctionGrant[] }> } } | { ok: false; message: string } {
  if (!isRecord(raw)) return { ok: false, message: "tools must be an object" };
  const unknown = Object.keys(raw).find((key) => key !== "functions");
  if (unknown) return { ok: false, message: `tools has unknown key "${unknown}"` };
  if (raw.functions === undefined) return { ok: true, value: { functions: [] } };
  if (!Array.isArray(raw.functions)) return { ok: false, message: "tools.functions must be a list" };
  const functions: Array<{ id: string; grants: FunctionGrant[] }> = [];
  const seen = new Set<string>();
  for (let index = 0; index < raw.functions.length; index += 1) {
    const parsed = parseFunctionAttachment(raw.functions[index], `tools.functions[${index}]`);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value.id)) return { ok: false, message: `tools.functions lists ${parsed.value.id} twice` };
    seen.add(parsed.value.id);
    functions.push(parsed.value);
  }
  return { ok: true, value: { functions } };
}

export function parseFunctionAttachment(raw: unknown, field: string): { ok: true; value: { id: string; grants: FunctionGrant[] } } | { ok: false; message: string } {
  if (typeof raw === "string" && FUNCTION_ID.test(raw)) return { ok: true, value: { id: raw, grants: [] } };
  if (!isRecord(raw) || typeof raw.id !== "string" || !FUNCTION_ID.test(raw.id)) {
    return { ok: false, message: `${field} needs a function id` };
  }
  const grants = parseFunctionGrants(raw.grants, `${field}.grants`);
  if (!grants.ok) return grants;
  return { ok: true, value: { id: raw.id, grants: grants.value } };
}

export async function attachmentIssuesFromFiles(projectRoot: string, uses: readonly FunctionUse[]): Promise<FunctionIssue[]> {
  const issues: FunctionIssue[] = [];
  for (const use of uses) {
    const file = await readFunctionFile(projectRoot, use.id);
    if (file.missing) {
      issues.push(issue(use.id, "function.missing", `Function "${use.id}" was not found`));
      continue;
    }
    if (!file.parsed.ok) {
      issues.push(issue(use.id, "function.invalid", `Function "${use.id}" could not be parsed`));
      continue;
    }
    const definition = file.parsed.value;
    if (definition.id !== use.id) {
      issues.push(issue(use.id, "function.missing", `Function "${use.id}" was not found`));
      continue;
    }
    if (definition.kind !== use.kind) {
      issues.push(
        issue(use.id, "function.kind_mismatch", `${definition.kind} function "${use.id}" cannot be attached as a ${use.kind}`),
      );
      continue;
    }
    const byId = new Map(definition.capabilities.map((capability) => [capability.id, capability]));
    for (const capability of definition.capabilities) {
      const grant = use.grants.find((item) => item.id === capability.id);
      if (!grant || !grantMatches(capability, grant)) {
        issues.push(issue(use.id, "function.under_granted", `Capability ${capability.id} is not granted on "${use.id}"`));
      }
    }
    for (const grant of use.grants) {
      if (!byId.has(grant.id)) {
        issues.push(issue(use.id, "function.grant_not_requested", `Grant ${grant.id} is not requested by "${use.id}"`));
      }
    }
  }
  return issues;
}

export async function copyFunctionCatalog(fromRoot: string, toRoot: string): Promise<void> {
  if (path.resolve(fromRoot) === path.resolve(toRoot)) return;
  const source = path.join(fromRoot, "functions");
  try {
    await access(source);
  } catch {
    return;
  }
  await cp(source, path.join(toRoot, "functions"), { recursive: true });
}

function referencedIds(doc: unknown): { ids: string[]; uses: string[]; includes: string[] } {
  const ids: string[] = [];
  const uses: string[] = [];
  const includes: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;
    if (typeof node.function === "string") ids.push(node.function);
    else if (isRecord(node.function) && typeof node.function.id === "string") ids.push(node.function.id);
    if (Array.isArray(node.functions)) {
      for (const entry of node.functions) {
        if (isRecord(entry) && typeof entry.id === "string") ids.push(entry.id);
      }
    }
    if (typeof node.uses === "string") uses.push(node.uses);
    if (Array.isArray(node.include)) {
      for (const entry of node.include) {
        if (isRecord(entry) && typeof entry.local === "string") includes.push(entry.local);
      }
    }
    for (const value of Object.values(node)) {
      if (isRecord(value) || Array.isArray(value)) visit(value);
    }
  };
  visit(doc);
  return { ids, uses, includes };
}

async function readYamlFile(filePath: string): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: parseYaml(await readFile(filePath, "utf8")) };
  } catch {
    return { ok: false };
  }
}

export async function findFunctionUsages(
  projectRoot: string,
  functionId: string,
): Promise<{ ok: true; usages: FunctionUsage[] } | { ok: false; message: string }> {
  const usages: FunctionUsage[] = [];
  const seen = new Set<string>();

  const consider = async (filePath: string, kind: FunctionUsage["kind"]): Promise<string | undefined> => {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved) || isFunctionDefinitionFile(resolved)) return undefined;
    seen.add(resolved);
    let text: string;
    try {
      text = await readFile(resolved, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return "A catalog file could not be read";
    }
    let doc: unknown;
    try {
      doc = parseYaml(text);
    } catch {
      return "A catalog file could not be parsed";
    }
    const refs = referencedIds(doc);
    if (refs.ids.includes(functionId)) {
      usages.push({ kind, path: path.relative(projectRoot, resolved).replace(/\\/g, "/") });
    }
    for (const relative of [...refs.uses, ...refs.includes]) {
      const next = path.resolve(path.dirname(resolved), relative);
      const nestedKind = kind === "agent" ? "stage" : kind;
      const failure = await consider(next, nestedKind);
      if (failure) return failure;
    }
    return undefined;
  };

  const manifest = await loadStageflowManifestOutcome(projectRoot);
  if (!manifest.ok) {
    const missing = manifest.issues.every((item) => item.message.startsWith("Manifest not found"));
    if (!missing) return { ok: false, message: "The project catalog could not be read" };
  } else {
    const exclude = manifest.value.manifest.catalog.exclude;
    const pattern = manifest.value.patterns.pipeline;
    for (const entry of manifest.value.manifest.catalog.pipelines) {
      const root = path.join(projectRoot, entry);
      const failure = await walkCatalog(root, projectRoot, pattern, exclude, async (filePath) => consider(filePath, "pipeline"));
      if (failure) return { ok: false, message: failure };
    }
  }

  const agentsDir = path.join(projectRoot, "agents");
  let agentNames: string[];
  try {
    agentNames = await readdir(agentsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, message: "Agent definitions could not be read" };
    agentNames = [];
  }
  for (const name of agentNames) {
    if (!name.endsWith(".agent.yaml")) continue;
    const failure = await consider(path.join(agentsDir, name), "agent");
    if (failure) return { ok: false, message: failure };
  }
  return { ok: true, usages };
}

async function walkCatalog(
  directory: string,
  projectRoot: string,
  pattern: string,
  exclude: string[] | undefined,
  visit: (filePath: string) => Promise<string | undefined>,
): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return "A catalog directory could not be read";
  }
  const matcher = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    const relative = path.relative(projectRoot, full).replace(/\\/g, "/");
    if (isExcluded(relative, exclude)) continue;
    if (entry.isDirectory()) {
      const failure = await walkCatalog(full, projectRoot, pattern, exclude, visit);
      if (failure) return failure;
      continue;
    }
    if (!entry.isFile()) continue;
    const stageFile = entry.name.endsWith(".stage.yaml") || entry.name.endsWith(".stage.yml");
    if (!matcher.test(entry.name) && !stageFile) continue;
    if (isFunctionDefinitionFile(entry.name)) continue;
    const failure = await visit(full);
    if (failure) return failure;
  }
  return undefined;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

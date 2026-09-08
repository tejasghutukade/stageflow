import { readFile } from "node:fs/promises";
import path from "node:path";
import { STAGEFLOW_MCP_SERVER_NAME } from "../agent/claudeTools.js";

export type StageMcpErrorCode =
  | "missing_catalog"
  | "unknown_server"
  | "reserved_name"
  | "unresolved_var"
  | "invalid_config"
  | "connect_failed";

export class StageMcpError extends Error {
  readonly code: StageMcpErrorCode;

  constructor(message: string, code: StageMcpErrorCode) {
    super(message);
    this.name = "StageMcpError";
    this.code = code;
  }
}

export type ResolvedMcpServerConfig = Record<string, unknown>;

export type ResolvedMcpServers = Record<string, ResolvedMcpServerConfig>;

export const MCP_CATALOG_FILENAME = ".mcp.json";

export type McpCatalogServers = Record<string, Record<string, unknown>>;

export type InspectedMcpCatalog = {
  path: string;
  servers: McpCatalogServers;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mcpCatalogPath(projectRoot: string): string {
  return path.join(projectRoot, MCP_CATALOG_FILENAME);
}

export function parseMcpCatalog(
  raw: string,
  catalogPath: string = MCP_CATALOG_FILENAME,
): McpCatalogServers {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StageMcpError(
      `MCP catalog "${catalogPath}" is not valid JSON`,
      "invalid_config",
    );
  }
  if (!isPlainObject(parsed)) {
    throw new StageMcpError(
      `MCP catalog "${catalogPath}" must be a JSON object`,
      "invalid_config",
    );
  }
  if (!Object.hasOwn(parsed, "mcpServers")) {
    throw new StageMcpError(
      `MCP catalog "${catalogPath}" is missing mcpServers`,
      "invalid_config",
    );
  }
  const mcpServers = parsed.mcpServers;
  if (!isPlainObject(mcpServers)) {
    throw new StageMcpError(
      `MCP catalog "${catalogPath}" mcpServers must be an object`,
      "invalid_config",
    );
  }
  const servers: McpCatalogServers = {};
  for (const [name, entry] of Object.entries(mcpServers)) {
    if (name === STAGEFLOW_MCP_SERVER_NAME) {
      throw new StageMcpError(
        `MCP catalog must not include reserved name "${STAGEFLOW_MCP_SERVER_NAME}"`,
        "reserved_name",
      );
    }
    if (!isPlainObject(entry)) {
      throw new StageMcpError(
        `MCP catalog server "${name}" must be an object`,
        "invalid_config",
      );
    }
    servers[name] = entry;
  }
  return servers;
}

export async function loadMcpCatalog(projectRoot: string): Promise<InspectedMcpCatalog> {
  const catalogPath = mcpCatalogPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(catalogPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new StageMcpError(
        `MCP catalog "${MCP_CATALOG_FILENAME}" is missing`,
        "missing_catalog",
      );
    }
    throw new StageMcpError(
      `MCP catalog "${MCP_CATALOG_FILENAME}" could not be read`,
      "invalid_config",
    );
  }
  return { path: catalogPath, servers: parseMcpCatalog(raw, catalogPath) };
}

export function assertMcpAllowlistKnown(
  servers: McpCatalogServers,
  allowlist: readonly string[],
): void {
  for (const name of allowlist) {
    if (!Object.hasOwn(servers, name)) {
      throw new StageMcpError(`Unknown MCP server "${name}"`, "unknown_server");
    }
  }
}

const INTERPOLATION_TOKEN = /\$\{([^}]*)\}/g;
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_WITH_DEFAULT = /^([A-Za-z_][A-Za-z0-9_]*):-(.*)$/;

function interpolateString(
  value: string,
  env: NodeJS.ProcessEnv,
  serverName: string,
): string {
  return value.replace(INTERPOLATION_TOKEN, (_match, inner: string) => {
    const withDefault = ENV_VAR_WITH_DEFAULT.exec(inner);
    if (withDefault) {
      const found = env[withDefault[1]];
      return found !== undefined ? found : withDefault[2];
    }
    if (ENV_VAR_NAME.test(inner)) {
      const found = env[inner];
      if (found !== undefined) {
        return found;
      }
      throw new StageMcpError(
        `Unresolved MCP catalog variable "${inner}"`,
        "unresolved_var",
      );
    }
    throw new StageMcpError(
      `MCP catalog server "${serverName}" has an invalid interpolation form`,
      "invalid_config",
    );
  });
}

function interpolateField(
  key: string,
  value: unknown,
  env: NodeJS.ProcessEnv,
  serverName: string,
): unknown {
  if ((key === "command" || key === "url" || key === "cwd") && typeof value === "string") {
    return interpolateString(value, env, serverName);
  }
  if (key === "args" && Array.isArray(value)) {
    return value.map((item) =>
      typeof item === "string" ? interpolateString(item, env, serverName) : item,
    );
  }
  if ((key === "env" || key === "headers") && isPlainObject(value)) {
    const copied: Record<string, unknown> = {};
    for (const [field, fieldValue] of Object.entries(value)) {
      copied[field] =
        typeof fieldValue === "string"
          ? interpolateString(fieldValue, env, serverName)
          : fieldValue;
    }
    return copied;
  }
  return value;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function isRelativeFsPath(value: string): boolean {
  if (value.length === 0 || path.isAbsolute(value) || value.startsWith("-") || value.startsWith("@")) {
    return false;
  }
  return hasPathSeparator(value) || value.startsWith(".");
}

function isInsideProjectRoot(projectRoot: string, candidate: string): boolean {
  const root = path.resolve(projectRoot);
  const resolved = path.resolve(candidate);
  const rel = path.relative(root, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function stampSpawnRoot(
  resolved: ResolvedMcpServerConfig,
  projectRoot: string,
  serverName: string,
): ResolvedMcpServerConfig {
  const command = resolved.command;
  if (typeof command === "string" && hasPathSeparator(command) && !path.isAbsolute(command)) {
    resolved.command = path.resolve(projectRoot, command);
  }
  if (Array.isArray(resolved.args)) {
    resolved.args = resolved.args.map((item) =>
      typeof item === "string" && isRelativeFsPath(item)
        ? path.resolve(projectRoot, item)
        : item,
    );
  }

  const catalogCwd = resolved.cwd;
  if (catalogCwd !== undefined) {
    if (typeof catalogCwd !== "string" || catalogCwd.length === 0 || !path.isAbsolute(catalogCwd)) {
      throw new StageMcpError(
        `MCP catalog server "${serverName}" cwd must be an absolute path inside the project root`,
        "invalid_config",
      );
    }
    const canonical = path.resolve(catalogCwd);
    if (!isInsideProjectRoot(projectRoot, canonical)) {
      throw new StageMcpError(
        `MCP catalog server "${serverName}" cwd is outside the project root`,
        "invalid_config",
      );
    }
    resolved.cwd = canonical;
  } else if (typeof command === "string") {
    resolved.cwd = path.resolve(projectRoot);
  }
  return resolved;
}

function interpolateServer(
  entry: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  serverName: string,
  projectRoot: string,
): ResolvedMcpServerConfig {
  const resolved: ResolvedMcpServerConfig = {};
  for (const [key, value] of Object.entries(entry)) {
    resolved[key] = interpolateField(key, value, env, serverName);
  }
  return stampSpawnRoot(resolved, projectRoot, serverName);
}

export async function resolveStageMcpServers(options: {
  projectRoot: string;
  allowlist?: readonly string[];
  env: NodeJS.ProcessEnv;
}): Promise<ResolvedMcpServers> {
  const allowlist = options.allowlist ?? [];
  if (allowlist.length === 0) {
    return {};
  }
  const catalog = await loadMcpCatalog(options.projectRoot);
  assertMcpAllowlistKnown(catalog.servers, allowlist);
  const resolved: ResolvedMcpServers = {};
  for (const name of allowlist) {
    resolved[name] = interpolateServer(
      catalog.servers[name],
      options.env,
      name,
      options.projectRoot,
    );
  }
  return resolved;
}

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

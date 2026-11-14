import { formatToolName } from "pi-mcp-adapter/types";
import {
  type FrozenHostLoginServer,
} from "../config/hostLoginMcp.js";
import { prepareMcpOAuth } from "../config/mcpOAuth.js";
import {
  partitionHostLogin,
  resolveStageMcpServersDetailed,
} from "../config/resolveStageMcpServers.js";
import type { StageMcpTools } from "../types/stage.js";
import type { DerivedBindingKind } from "./stageRoots.js";

export const STAGE_MCP_NATIVE_TOOLS_REASON =
  "Cursor models run their own file and shell tools outside this agent's grants and approvals. Choose another provider's model, or set STAGEFLOW_AGENTS_ALLOW_CURSOR_NATIVE_TOOLS=1 on the Host to accept that.";

export type StageMcpAllowlistStage = {
  mcp?: readonly string[];
  mcp_tools?: StageMcpTools;
  secrets?: readonly { name: string }[];
};

export type StageMcpCallView =
  | { ok: true; text: string }
  | { ok: false; code: string; message: string };

export type StageMcpListedTool = {
  server: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type StageMcpListView =
  | { ok: true; tools: StageMcpListedTool[] }
  | { ok: false; code: string; message: string };

export type StageMcpUpstreamTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type StageMcpUpstream = {
  list(
    server: FrozenHostLoginServer,
    signal: AbortSignal,
  ): Promise<{ ok: true; tools: StageMcpUpstreamTool[] } | { ok: false; code: string; message: string }>;
  call(
    server: FrozenHostLoginServer,
    tool: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<StageMcpCallView>;
};

const defaultUpstream: StageMcpUpstream = {
  async list() {
    return { ok: false, code: "connect_failed", message: "connect_failed" };
  },
  async call() {
    return { ok: false, code: "connect_failed", message: "connect_failed" };
  },
};

let upstream: StageMcpUpstream = defaultUpstream;

export function setStageMcpUpstreamForTests(next: StageMcpUpstream | undefined): void {
  upstream = next ?? defaultUpstream;
}

export function stageMcpSessionToolName(server: string, tool: string): string {
  return formatToolName(tool, server, "server");
}

function wildcard(names: readonly string[] | undefined): boolean {
  return names !== undefined && names.length === 1 && names[0] === "*";
}

/** A present `mcp_tools` entry that is not `["*"]` is a named allowlist. */
export function stageMcpAllowlistRestricts(stage: { mcp_tools?: StageMcpTools } | undefined): boolean {
  const tools = stage?.mcp_tools;
  if (tools === undefined) return false;
  return Object.values(tools).some((names) => !wildcard(names));
}

export function stageMcpToolPermitted(
  stage: StageMcpAllowlistStage | undefined,
  server: string,
  tool: string,
): boolean {
  if (!stage?.mcp?.includes(server)) return false;
  if (stage.mcp_tools === undefined) return true;
  const named = stage.mcp_tools[server];
  if (named === undefined) return false;
  if (wildcard(named)) return true;
  return named.includes(tool);
}

function denied(): { ok: false; code: string; message: string } {
  return { ok: false, code: "permission_denied", message: "permission_denied" };
}

function cancelled(): { ok: false; code: string; message: string } {
  return { ok: false, code: "cancelled", message: "cancelled" };
}

function failed(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message };
}

/**
 * Host-login names for the stage this process forked. The child writes
 * `freezeHostLoginServers` in its own process; that map is not the authority here.
 */
export async function classifyParentHostLogin(input: {
  stage?: StageMcpAllowlistStage;
  bindingKind?: DerivedBindingKind;
  factoryCwd?: string;
  rootDir: string;
  env?: Record<string, string>;
}): Promise<readonly FrozenHostLoginServer[]> {
  const names = input.stage?.mcp ?? [];
  if (names.length === 0) return [];
  const repository = input.bindingKind === "repository";
  try {
    const resolution = await resolveStageMcpServersDetailed({
      projectRoot: input.factoryCwd ?? input.rootDir,
      allowlist: [...names],
      env: input.env ?? {},
      bindingKind: repository ? "repository" : input.bindingKind === "checkout" ? "checkout" : "none",
      ...(repository
        ? {}
        : { scope: { kind: "stage" as const, secrets: (input.stage?.secrets ?? []).map((secret) => secret.name) } }),
    });
    return partitionHostLogin(resolution, {
      bindingKind: repository ? "repository" : input.bindingKind === "checkout" ? "checkout" : "none",
    }).hostLogin;
  } catch {
    return [];
  }
}

export async function serveStageMcpList(input: {
  frozen: readonly FrozenHostLoginServer[];
  stage: StageMcpAllowlistStage;
  signal: AbortSignal;
}): Promise<StageMcpListView> {
  if (input.signal.aborted) return cancelled();
  const tools: StageMcpListedTool[] = [];
  let opened = false;
  for (const server of input.frozen) {
    if (!input.stage.mcp?.includes(server.name)) continue;
    if (input.signal.aborted) return cancelled();
    if (!opened) {
      prepareMcpOAuth();
      opened = true;
    }
    let listed: Awaited<ReturnType<StageMcpUpstream["list"]>>;
    try {
      listed = await upstream.list(server, input.signal);
    } catch {
      if (input.signal.aborted) return cancelled();
      return failed("connect_failed", "connect_failed");
    }
    if (!listed.ok) return failed(listed.code, listed.message);
    for (const tool of listed.tools) {
      if (!stageMcpToolPermitted(input.stage, server.name, tool.name)) continue;
      tools.push({
        server: server.name,
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
      });
    }
  }
  return { ok: true, tools };
}

export async function serveStageMcpCall(input: {
  frozen: readonly FrozenHostLoginServer[];
  stage: StageMcpAllowlistStage;
  server: string;
  tool: string;
  arguments: unknown;
  signal: AbortSignal;
}): Promise<StageMcpCallView> {
  if (input.signal.aborted) return cancelled();
  const server = input.frozen.find((item) => item.name === input.server);
  if (!server || !stageMcpToolPermitted(input.stage, input.server, input.tool)) return denied();
  prepareMcpOAuth();
  if (input.signal.aborted) return cancelled();
  try {
    const result = await upstream.call(server, input.tool, input.arguments, input.signal);
    if (result.ok) return { ok: true, text: result.text };
    return failed(result.code, result.message);
  } catch {
    if (input.signal.aborted) return cancelled();
    return failed("connect_failed", "connect_failed");
  }
}

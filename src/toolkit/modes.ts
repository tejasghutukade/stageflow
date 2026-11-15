export type ResolvedMode = {
  mode: string;
  primaryId?: string;
};

export type ModeResolverRejection = {
  ok: false;
  message: string;
};

export type ModeResolverSuccess = {
  ok: true;
  resolved: ResolvedMode;
};

export type ModeResolverResult = ModeResolverSuccess | ModeResolverRejection;

export type ModeResolver = (args: Record<string, unknown>) => ModeResolverResult;

import { AGENT_FUNCTION_TOOL_MODE_RESOLVERS } from "./agentFunctionToolModes.js";
import { CATALOG_TOOL_MODE_RESOLVERS } from "./catalogToolModes.js";
import { RUN_TOOL_MODE_RESOLVERS } from "./runToolModes.js";
import { EVAL_TOOL_MODE_RESOLVERS } from "./evalToolModes.js";
import { TRIGGER_CONNECTION_MEMORY_TOOL_MODE_RESOLVERS } from "./triggerConnectionMemoryToolModes.js";

export const MODE_RESOLVERS: Readonly<Partial<Record<string, ModeResolver>>> = {
  ...RUN_TOOL_MODE_RESOLVERS,
  ...CATALOG_TOOL_MODE_RESOLVERS,
  ...AGENT_FUNCTION_TOOL_MODE_RESOLVERS,
  ...EVAL_TOOL_MODE_RESOLVERS,
  ...TRIGGER_CONNECTION_MEMORY_TOOL_MODE_RESOLVERS,
};

const testResolvers = new Map<string, ModeResolver>();

export function registerModeResolver(tool: string, resolver: ModeResolver | undefined): void {
  if (resolver === undefined) testResolvers.delete(tool);
  else testResolvers.set(tool, resolver);
}

export function resolveMode(tool: string, args: Record<string, unknown>): ModeResolverResult | undefined {
  const resolver = testResolvers.get(tool) ?? MODE_RESOLVERS[tool];
  if (!resolver) return undefined;
  return resolver(args);
}
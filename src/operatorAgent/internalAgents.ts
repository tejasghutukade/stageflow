import type { OperatorAgentHost } from "./types.js";

export const SHOW_INTERNAL_AGENTS_ENV = "STAGEFLOW_SHOW_INTERNAL_AGENTS";

export type InternalAgentInfo = {
  id: string;
  title: string;
  greeting?: string;
  playbook: string;
  tools: string[];
};

export function internalAgentsVisible(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SHOW_INTERNAL_AGENTS_ENV] === "1";
}

export function describeInternalAgents(host: OperatorAgentHost): InternalAgentInfo[] {
  return host.listProfiles().map((profile) => ({
    id: profile.id,
    title: profile.title,
    ...(profile.greeting !== undefined ? { greeting: profile.greeting } : {}),
    playbook: profile.playbook,
    tools: profile.tools.map((tool) => tool.name),
  }));
}

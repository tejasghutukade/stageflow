import type { ServerResponse } from "node:http";
import { describeInternalAgents, internalAgentsVisible } from "../operatorAgent/internalAgents.js";
import type { OperatorAgentHost } from "../operatorAgent/index.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

export const INTERNAL_AGENTS_PATH = "/api/internal-agents";

export function handleInternalAgentRoutes(
  method: string,
  pathname: string,
  host: OperatorAgentHost,
  res: ServerResponse,
  json: Json,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (pathname !== INTERNAL_AGENTS_PATH || method !== "GET") return false;
  if (!internalAgentsVisible(env)) {
    json(res, 200, { visible: false, agents: [] });
    return true;
  }
  json(res, 200, { visible: true, agents: describeInternalAgents(host) });
  return true;
}

import { authorizationHeaders } from "./controlToken";

/** Wire type for `GET /api/internal-agents` (src/operatorAgent/internalAgents.ts). */
export type InternalAgent = {
  id: string;
  title: string;
  greeting?: string;
  playbook: string;
  tools: string[];
};

export type InternalAgentsResponse = { visible: boolean; agents: InternalAgent[] };

export const HIDDEN_INTERNAL_AGENTS: InternalAgentsResponse = { visible: false, agents: [] };

/** Any failure reads as hidden. */
export async function fetchInternalAgents(): Promise<InternalAgentsResponse> {
  try {
    const res = await fetch("/api/internal-agents", { headers: authorizationHeaders() });
    if (!res.ok) return HIDDEN_INTERNAL_AGENTS;
    const body = (await res.json()) as Partial<InternalAgentsResponse>;
    if (body.visible !== true || !Array.isArray(body.agents)) return HIDDEN_INTERNAL_AGENTS;
    return { visible: true, agents: body.agents };
  } catch {
    return HIDDEN_INTERNAL_AGENTS;
  }
}

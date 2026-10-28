import { AgentApiError, type AgentDefinition, type AgentDetail } from "../../../api/agents";

/** Mirrors `src/agents/agentId.ts` `slugAgentId` — keep in sync. */
export function slugAgentId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 56);
  return /^[a-z][a-z0-9_]{0,63}$/.test(slug) ? slug : "";
}

/** Empty id, or id that matches the slug derived from name (author auto-fill). */
export function isAutoDerivedAgentId(id: string, name: string): boolean {
  const trimmed = id.trim();
  if (!trimmed) return true;
  const slug = slugAgentId(name);
  return Boolean(slug) && trimmed === slug;
}

export function messageForExplicitIdCollision(id: string): string {
  const trimmed = id.trim() || id;
  return `An agent with id "${trimmed}" already exists. Choose a different id.`;
}

/**
 * On `agent.exists`: auto-slugged ids clear and retry so the server can uniquify;
 * explicitly set ids fail closed with a readable message.
 */
export async function createAgentHandlingIdCollision(
  definition: AgentDefinition,
  create: (definition: AgentDefinition) => Promise<AgentDetail>,
): Promise<AgentDetail> {
  try {
    return await create(definition);
  } catch (error) {
    if (!(error instanceof AgentApiError) || error.code !== "agent.exists") throw error;
    if (!isAutoDerivedAgentId(definition.id, definition.name)) {
      throw new AgentApiError(error.code, error.status, messageForExplicitIdCollision(definition.id), error.issues);
    }
    return await create({ ...definition, id: "" });
  }
}

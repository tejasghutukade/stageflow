import type { OperatorAgentContextAdapter, OperatorAgentProposal } from "./types.js";

/**
 * The unsaved agent definition the author edits: any subset of the v2 agent
 * schema (src/config/loadAgent.ts). It may be incomplete or invalid while the
 * operator is still describing the agent; Save validates it.
 */
export type AgentAuthorDraft = Record<string, unknown>;

export type AgentAuthorContext = {
  kind: "agent_author";
  projectRoot?: string;
  draft: AgentAuthorDraft;
};

export const AGENT_AUTHOR_GREETING =
  "Who is this agent for, and what does a good result look like? I'll ask a few questions before I fill the config.";

export function emptyAgentAuthorDraft(): AgentAuthorDraft {
  return {};
}

export function isAgentAuthorContext(value: unknown): value is AgentAuthorContext {
  if (value === null || typeof value !== "object") return false;
  const record = value as { kind?: unknown; draft?: unknown };
  return (
    record.kind === "agent_author" &&
    record.draft !== null &&
    typeof record.draft === "object" &&
    !Array.isArray(record.draft)
  );
}

export function readAgentAuthorDraft(context: unknown): AgentAuthorDraft {
  return isAgentAuthorContext(context) ? structuredClone(context.draft) : emptyAgentAuthorDraft();
}

export function agentAuthorContextAdapter(): OperatorAgentContextAdapter {
  return {
    serialize: (context) => context ?? { kind: "agent_author", draft: emptyAgentAuthorDraft() },
    applyProposal: (context, proposal: OperatorAgentProposal) => {
      if (!isAgentAuthorContext(proposal.nextContext)) return context;
      const current = isAgentAuthorContext(context) ? context : undefined;
      const projectRoot = proposal.nextContext.projectRoot ?? current?.projectRoot;
      return {
        kind: "agent_author",
        ...(projectRoot ? { projectRoot } : {}),
        draft: structuredClone(proposal.nextContext.draft),
      } satisfies AgentAuthorContext;
    },
  };
}

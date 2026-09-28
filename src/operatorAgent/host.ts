import {
  autoApplyStatusMessage,
  enrichProposal,
  isProposalStale,
  parseAutoApplyIntent,
  STALE_PROPOSAL_NOTICE,
  type AcceptProposalResult,
} from "./proposals.js";
import type {
  OperatorAgentHost,
  OperatorAgentProfile,
  OperatorAgentProposal,
  OperatorAgentSession,
  OperatorAgentSessionEvent,
  OperatorAgentToolContext,
  OperatorAgentToolResult,
} from "./types.js";

export type OperatorAgentModelTurn = {
  events: OperatorAgentSessionEvent[];
};

export type OperatorAgentModel = {
  complete(input: {
    profile: OperatorAgentProfile;
    message: string;
    contextSnapshot: unknown;
    tools: OperatorAgentToolContext;
    autoApply: boolean;
  }): Promise<OperatorAgentModelTurn>;
};

function createSession(
  profile: OperatorAgentProfile,
  initialContext: unknown,
  model: OperatorAgentModel,
): OperatorAgentSession {
  let context = initialContext;
  let pending: OperatorAgentProposal | null = null;
  let autoApply = false;
  let closed = false;
  let lastEmitted: OperatorAgentProposal | null = null;
  let lastEmitAutoApplied = false;

  const toolContext: OperatorAgentToolContext = {
    getContext: () => context,
    setContext: (next) => {
      context = next;
    },
    getAutoApply: () => autoApply,
    emitProposal: (proposal) => {
      const enriched = enrichProposal(proposal, context);
      lastEmitted = enriched;
      if (autoApply) {
        context = profile.contextAdapter.applyProposal(context, enriched);
        pending = null;
        lastEmitAutoApplied = true;
        return;
      }
      pending = enriched;
      lastEmitAutoApplied = false;
    },
  };

  return {
    profileId: profile.id,
    profileTitle: profile.title,
    getContext: () => context,
    setContext: (next) => {
      context = next;
    },
    getPendingProposal: () => pending,
    getAutoApply: () => autoApply,
    setAutoApply: (enabled) => {
      autoApply = enabled;
    },
    async send(message: string): Promise<OperatorAgentSessionEvent[]> {
      if (closed) {
        return [{ type: "error", message: "session is closed" }];
      }
      const intent = parseAutoApplyIntent(message);
      if (intent !== null) {
        autoApply = intent;
        return [
          {
            type: "message",
            role: "system",
            text: autoApplyStatusMessage(intent),
          },
        ];
      }
      lastEmitted = null;
      lastEmitAutoApplied = false;
      const turn = await model.complete({
        profile,
        message,
        contextSnapshot: profile.contextAdapter.serialize(context),
        tools: toolContext,
        autoApply,
      });
      const events: OperatorAgentSessionEvent[] = [];
      for (const event of turn.events) {
        if (event.type === "proposal") {
          events.push({
            type: "proposal",
            proposal: lastEmitted ?? enrichProposal(event.proposal, context),
            autoApplied: lastEmitAutoApplied,
          });
        } else {
          events.push(event);
        }
      }
      return events;
    },
    acceptProposal(proposalId?: string): AcceptProposalResult {
      if (!pending) return { ok: false, reason: "none" };
      if (proposalId !== undefined && pending.id !== proposalId) {
        return { ok: false, reason: "id_mismatch" };
      }
      if (isProposalStale(pending, context)) {
        pending = null;
        return {
          ok: false,
          reason: "stale",
          notice: STALE_PROPOSAL_NOTICE,
        };
      }
      context = profile.contextAdapter.applyProposal(context, pending);
      pending = null;
      return { ok: true };
    },
    rejectProposal(proposalId?: string): boolean {
      if (!pending) return false;
      if (proposalId !== undefined && pending.id !== proposalId) return false;
      pending = null;
      return true;
    },
    close(): void {
      closed = true;
      pending = null;
    },
  };
}

export function createOperatorAgentHost(
  model: OperatorAgentModel,
  seedProfiles: OperatorAgentProfile[] = [],
): OperatorAgentHost {
  const profiles = new Map<string, OperatorAgentProfile>();
  for (const profile of seedProfiles) {
    profiles.set(profile.id, profile);
  }

  return {
    registerProfile(profile) {
      profiles.set(profile.id, profile);
    },
    getProfile(id) {
      return profiles.get(id);
    },
    listProfiles() {
      return [...profiles.values()];
    },
    openSession({ profileId, context }) {
      const profile = profiles.get(profileId);
      if (!profile) {
        throw new Error(`Unknown operator agent profile: ${profileId}`);
      }
      return createSession(profile, context, model);
    },
  };
}

export async function invokeProfileTool(
  profile: OperatorAgentProfile,
  name: string,
  args: Record<string, unknown>,
  ctx: OperatorAgentToolContext,
): Promise<OperatorAgentToolResult> {
  const tool = profile.tools.find((t) => t.name === name);
  if (!tool) {
    return { ok: false, content: null, error: `Unknown tool: ${name}` };
  }
  return tool.handler(args, ctx);
}

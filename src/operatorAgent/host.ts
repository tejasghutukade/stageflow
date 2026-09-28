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
  }): Promise<OperatorAgentModelTurn>;
};

function createSession(
  profile: OperatorAgentProfile,
  initialContext: unknown,
  model: OperatorAgentModel,
): OperatorAgentSession {
  let context = initialContext;
  let pending: OperatorAgentProposal | null = null;
  let closed = false;

  const toolContext: OperatorAgentToolContext = {
    getContext: () => context,
    setContext: (next) => {
      context = next;
    },
    emitProposal: (proposal) => {
      pending = proposal;
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
    async send(message: string): Promise<OperatorAgentSessionEvent[]> {
      if (closed) {
        return [{ type: "error", message: "session is closed" }];
      }
      const turn = await model.complete({
        profile,
        message,
        contextSnapshot: profile.contextAdapter.serialize(context),
        tools: toolContext,
      });
      return turn.events;
    },
    acceptProposal(proposalId?: string): boolean {
      if (!pending) return false;
      if (proposalId !== undefined && pending.id !== proposalId) return false;
      context = profile.contextAdapter.applyProposal(context, pending);
      pending = null;
      return true;
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

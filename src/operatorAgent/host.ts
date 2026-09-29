import { readDraftFromContext } from "./draftContext.js";
import {
  draftFingerprint,
  enrichProposal,
  isMutationConflict,
  UNDO_MUTATION_CONFLICT_NOTICE,
  type AcceptProposalResult,
  type UndoMutationResult,
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
  }): Promise<OperatorAgentModelTurn>;
  /**
   * Optional restart seed (KTD7): inject prior transcript into a new backend
   * session before the first complete for this host session.
   */
  prepareRestart?(input: {
    tools: OperatorAgentToolContext;
    profile: OperatorAgentProfile;
    transcript: readonly { role: string; text: string }[];
  }): Promise<void>;
  /** Optional: dispose backend resources bound to this tool context. */
  releaseTools?(tools: OperatorAgentToolContext): void | Promise<void>;
};

function createSession(
  profile: OperatorAgentProfile,
  initialContext: unknown,
  model: OperatorAgentModel,
): OperatorAgentSession {
  let context = initialContext;
  let closed = false;
  const mutations = new Map<string, OperatorAgentProposal>();
  let lastMutationId: string | null = null;
  let lastEmitted: OperatorAgentProposal | null = null;

  const toolContext: OperatorAgentToolContext = {
    getContext: () => context,
    setContext: (next) => {
      context = next;
    },
    emitProposal: (proposal) => {
      const enriched = enrichProposal(proposal, context);
      context = profile.contextAdapter.applyProposal(context, enriched);
      const applied: OperatorAgentProposal = {
        ...enriched,
        appliedFingerprint: draftFingerprint(readDraftFromContext(context)),
      };
      mutations.set(applied.id, applied);
      lastMutationId = applied.id;
      lastEmitted = applied;
    },
  };

  function resolveMutation(
    mutationId?: string,
  ):
    | { ok: true; mutation: OperatorAgentProposal }
    | { ok: false; reason: "none" | "id_mismatch" } {
    if (mutations.size === 0) return { ok: false, reason: "none" };
    const id = mutationId ?? lastMutationId;
    if (!id) return { ok: false, reason: "none" };
    const mutation = mutations.get(id);
    if (!mutation) {
      if (mutationId !== undefined) return { ok: false, reason: "id_mismatch" };
      return { ok: false, reason: "none" };
    }
    return { ok: true, mutation };
  }

  function undoMutation(mutationId?: string): UndoMutationResult {
    const resolved = resolveMutation(mutationId);
    if (!resolved.ok) return resolved;
    const { mutation } = resolved;
    if (isMutationConflict(mutation, context)) {
      return {
        ok: false,
        reason: "conflict",
        notice: UNDO_MUTATION_CONFLICT_NOTICE,
      };
    }
    if (mutation.baseContext !== undefined) {
      context = mutation.baseContext;
    }
    mutations.delete(mutation.id);
    if (lastMutationId === mutation.id) {
      lastMutationId = [...mutations.keys()].at(-1) ?? null;
    }
    return { ok: true };
  }

  return {
    profileId: profile.id,
    profileTitle: profile.title,
    getContext: () => context,
    setContext: (next) => {
      context = next;
    },
    getPendingProposal: () => {
      if (!lastMutationId) return null;
      return mutations.get(lastMutationId) ?? null;
    },
    getMutation: (mutationId) => mutations.get(mutationId) ?? null,
    async prepareRestart(transcript) {
      if (closed) return;
      if (!model.prepareRestart) return;
      await model.prepareRestart({
        profile,
        tools: toolContext,
        transcript,
      });
    },
    async send(message: string): Promise<OperatorAgentSessionEvent[]> {
      if (closed) {
        return [{ type: "error", message: "session is closed" }];
      }
      lastEmitted = null;
      const turn = await model.complete({
        profile,
        message,
        contextSnapshot: profile.contextAdapter.serialize(context),
        tools: toolContext,
      });
      const events: OperatorAgentSessionEvent[] = [];
      let sawProposal = false;
      for (const event of turn.events) {
        if (event.type === "proposal") {
          sawProposal = true;
          events.push({
            type: "proposal",
            proposal: lastEmitted ?? enrichProposal(event.proposal, context),
          });
        } else {
          events.push(event);
        }
      }
      if (!sawProposal && lastEmitted) {
        events.push({ type: "proposal", proposal: lastEmitted });
      }
      return events;
    },
    acceptProposal(proposalId?: string): AcceptProposalResult {
      const resolved = resolveMutation(proposalId);
      if (!resolved.ok) return resolved;
      mutations.delete(resolved.mutation.id);
      if (lastMutationId === resolved.mutation.id) {
        lastMutationId = [...mutations.keys()].at(-1) ?? null;
      }
      return { ok: true };
    },
    rejectProposal(proposalId?: string): UndoMutationResult {
      return undoMutation(proposalId);
    },
    undoMutation,
    close(): void {
      closed = true;
      mutations.clear();
      lastMutationId = null;
      void model.releaseTools?.(toolContext);
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

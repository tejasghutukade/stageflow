import {
  isTaskProposalIntent,
  proposeStageFromUserMessage,
  proposeTaskFromUserMessage,
  WORKSHOP_AUTHOR_PROFILE_ID,
} from "./profiles/workshopAuthor.js";
import { createOperatorAgentHost, type OperatorAgentModel } from "./host.js";
import { createWorkshopAuthorProfile } from "./profiles/workshopAuthor.js";
import type {
  OperatorAgentHost,
  OperatorAgentProposal,
  OperatorAgentSessionEvent,
} from "./types.js";

export type FakeOperatorTurn =
  | { type: "echo" }
  | { type: "propose_stage" }
  | { type: "propose_task" }
  | {
      type: "events";
      events: OperatorAgentSessionEvent[];
    }
  | {
      type: "propose";
      proposal: OperatorAgentProposal;
      message?: string;
    };

/**
 * Deterministic Operator Agent Host for Workshop and tests.
 * Does not call a live provider — scripted turns or auto stage/task proposals.
 */
export function createFakeOperatorAgentModel(
  script: FakeOperatorTurn[] = [{ type: "propose_stage" }],
): OperatorAgentModel {
  let index = 0;
  return {
    async complete({ message, tools }) {
      const turn = script[Math.min(index, script.length - 1)] ?? {
        type: "propose_stage" as const,
      };
      index += 1;

      if (turn.type === "events") {
        return { events: turn.events };
      }

      if (turn.type === "echo") {
        return {
          events: [
            {
              type: "message",
              role: "assistant",
              text: `Got it: ${message}`,
            },
          ],
        };
      }

      if (turn.type === "propose") {
        tools.emitProposal(turn.proposal);
        return {
          events: [
            {
              type: "message",
              role: "assistant",
              text: turn.message ?? turn.proposal.summary,
            },
            { type: "proposal", proposal: turn.proposal },
          ],
        };
      }

      const proposal =
        turn.type === "propose_task" || isTaskProposalIntent(message)
          ? proposeTaskFromUserMessage(tools, message)
          : proposeStageFromUserMessage(tools, message);
      const autoApplied = tools.getAutoApply();
      return {
        events: [
          {
            type: "message",
            role: "assistant",
            text: autoApplied
              ? `Applied to draft: ${proposal.summary}. Nothing was written to disk — Save when you are ready.`
              : `I propose: ${proposal.summary}. Review the per-artifact diff and Accept to update the draft, or Reject to leave it unchanged.`,
          },
          { type: "proposal", proposal },
        ],
      };
    },
  };
}

export function createWorkshopOperatorHost(
  script?: FakeOperatorTurn[],
): OperatorAgentHost {
  const host = createOperatorAgentHost(createFakeOperatorAgentModel(script), [
    createWorkshopAuthorProfile(),
  ]);
  return host;
}

export { WORKSHOP_AUTHOR_PROFILE_ID };

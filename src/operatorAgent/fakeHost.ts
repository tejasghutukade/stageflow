import {
  createOperatorAgentHost,
  invokeProfileTool,
  type OperatorAgentModel,
} from "./host.js";
import type { DocsRetriever } from "./docsRetrieval.js";
import {
  createWorkshopAuthorProfile,
  isTaskProposalIntent,
  proposeStageFromUserMessage,
  proposeTaskFromUserMessage,
  WORKSHOP_AUTHOR_PROFILE_ID,
  type WorkshopAuthorProfileOptions,
} from "./profiles/workshopAuthor.js";
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
    }
  | {
      type: "call_tool";
      name: string;
      args?: Record<string, unknown>;
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
    async complete({ profile, message, tools }) {
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

      if (turn.type === "call_tool") {
        const result = await invokeProfileTool(
          profile,
          turn.name,
          turn.args ?? {},
          tools,
        );
        const events: OperatorAgentSessionEvent[] = [
          { type: "tool_result", name: turn.name, result },
        ];
        if (turn.message) {
          events.push({
            type: "message",
            role: "assistant",
            text: turn.message,
          });
        } else if (!result.ok) {
          events.push({
            type: "message",
            role: "assistant",
            text: `Retrieval unavailable (${result.error ?? "error"}). Continuing with the baked Workshop Author playbook.`,
          });
        }
        return { events };
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

export type WorkshopOperatorHostOptions = WorkshopAuthorProfileOptions & {
  script?: FakeOperatorTurn[];
  retriever?: DocsRetriever;
};

export function createWorkshopOperatorHost(
  scriptOrOptions?: FakeOperatorTurn[] | WorkshopOperatorHostOptions,
): OperatorAgentHost {
  const options: WorkshopOperatorHostOptions = Array.isArray(scriptOrOptions)
    ? { script: scriptOrOptions }
    : (scriptOrOptions ?? {});
  const host = createOperatorAgentHost(
    createFakeOperatorAgentModel(options.script),
    [createWorkshopAuthorProfile({ retriever: options.retriever })],
  );
  return host;
}

export { WORKSHOP_AUTHOR_PROFILE_ID };

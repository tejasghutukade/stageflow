import type { ToolCallMessagePartComponent } from "@assistant-ui/react";

/** Tool name synthesized into assistant message parts for Accept/Reject cards. */
export const DRAFT_MUTATION_TOOL_NAME = "draft_mutation" as const;

export type DraftMutationProposalLike = {
  id: string;
  summary: string;
  affectedStageIds: string[];
};

export type DraftMutationToolPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: typeof DRAFT_MUTATION_TOOL_NAME;
  args: {
    mutationId: string;
    summary: string;
    affectedStageIds: string[];
  };
  argsText: string;
  result: { status: "applied" };
};

/** Stock Thread `MessagePrimitive.Parts` tools map for `draft_mutation`. */
export function buildDraftMutationTools(
  DraftMutationToolUI: ToolCallMessagePartComponent,
): {
  by_name: Record<string, ToolCallMessagePartComponent | undefined>;
} {
  return {
    by_name: {
      [DRAFT_MUTATION_TOOL_NAME]: DraftMutationToolUI,
    },
  };
}

/** Synthesize in-thread tool-call parts from host proposals (end-of-turn). */
export function buildDraftMutationToolParts(
  proposals: DraftMutationProposalLike[],
): DraftMutationToolPart[] {
  return proposals.map((proposal, index) => {
    const args = {
      mutationId: proposal.id,
      summary: proposal.summary,
      affectedStageIds: proposal.affectedStageIds,
    };
    return {
      type: "tool-call" as const,
      toolCallId: `mutation-${proposal.id}-${index}`,
      toolName: DRAFT_MUTATION_TOOL_NAME,
      args,
      argsText: JSON.stringify(args),
      result: { status: "applied" as const },
    };
  });
}

import {
  validateDraftPackage,
  type DraftPackage,
} from "../../config/draftPackage.js";
import {
  readDraftFromContext,
  workshopDraftContextAdapter,
  WORKSHOP_AUTHOR_GREETING,
} from "../draftContext.js";
import {
  affectedStageIds,
  diffDraftPackages,
  draftFingerprint,
} from "../proposals.js";
import type {
  OperatorAgentProfile,
  OperatorAgentProposal,
  OperatorAgentTool,
  OperatorAgentToolContext,
  OperatorAgentToolResult,
} from "../types.js";

export const WORKSHOP_AUTHOR_PROFILE_ID = "workshop-author";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

let proposalSeq = 0;

function nextProposalId(): string {
  proposalSeq += 1;
  return `proposal-${proposalSeq}`;
}

function slugifyStageId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "stage";
}

export function buildStageAddProposal(
  draft: DraftPackage,
  userText: string,
): OperatorAgentProposal {
  const existingIds = new Set(
    draft.pipeline.stages.map((s) => (typeof s.id === "string" ? s.id : "")),
  );
  let stageId = slugifyStageId(userText.split(/\s+/).slice(0, 3).join(" "));
  if (existingIds.has(stageId) || stageId === "untitled") {
    stageId = `${stageId}-${existingIds.size + 1}`;
  }

  const stageBody: Record<string, unknown> = {
    id: stageId,
    system_prompt: `Stage for: ${userText.trim() || "workshop draft"}`,
    model: DEFAULT_MODEL,
    ...REQUIRED_IO,
  };

  const usesPath = `./${stageId}.yaml`;
  const nextDraft: DraftPackage = {
    ...draft,
    pipeline: {
      ...draft.pipeline,
      stages: [
        ...draft.pipeline.stages,
        {
          id: stageId,
          uses: usesPath,
          ...(draft.pipeline.stages.length === 0 ? { entry: true } : {}),
        },
      ],
    },
    stages: [...(draft.stages ?? []), { path: usesPath, body: stageBody }],
  };

  return {
    id: nextProposalId(),
    summary: `Add stage “${stageId}”`,
    nextContext: nextDraft,
    baseContext: { draft },
    baseFingerprint: draftFingerprint(draft),
    artifacts: diffDraftPackages(draft, nextDraft),
    affectedStageIds: affectedStageIds(draft, nextDraft),
  };
}

const readDraftTool: OperatorAgentTool = {
  name: "read_draft",
  description: "Read the current Workshop virtual draft package",
  handler(_args, ctx): OperatorAgentToolResult {
    return {
      ok: true,
      content: workshopDraftContextAdapter.serialize(ctx.getContext()),
    };
  },
};

const proposeDraftTool: OperatorAgentTool = {
  name: "propose_draft",
  description: "Emit a structured proposal that replaces the draft on Accept",
  handler(args, ctx): OperatorAgentToolResult {
    const summary =
      typeof args.summary === "string" && args.summary.trim()
        ? args.summary.trim()
        : "Update draft";
    const nextDraft =
      args.draft !== null && typeof args.draft === "object"
        ? (args.draft as DraftPackage)
        : null;
    if (!nextDraft || !nextDraft.pipeline) {
      return { ok: false, content: null, error: "draft is required" };
    }
    const current = readDraftFromContext(ctx.getContext());
    const proposal: OperatorAgentProposal = {
      id: nextProposalId(),
      summary,
      nextContext: nextDraft,
      baseContext: { draft: current },
      baseFingerprint: draftFingerprint(current),
      artifacts: diffDraftPackages(current, nextDraft),
      affectedStageIds: affectedStageIds(current, nextDraft),
    };
    ctx.emitProposal(proposal);
    return { ok: true, content: proposal };
  },
};

const validateDraftTool: OperatorAgentTool = {
  name: "validate_draft",
  description: "Run catalog validation against the current draft",
  async handler(_args, ctx): Promise<OperatorAgentToolResult> {
    const draft = readDraftFromContext(ctx.getContext());
    const result = await validateDraftPackage(draft, { strict: true });
    return { ok: result.ok, content: result };
  },
};

export const workshopAuthorTools: OperatorAgentTool[] = [
  readDraftTool,
  proposeDraftTool,
  validateDraftTool,
];

export const WORKSHOP_AUTHOR_PLAYBOOK = `You are the Stageflow Workshop Author.
Read the current draft before proposing changes.
Propose concrete pipeline/stage package edits; do not write disk yourself.
Prefer catalog dialect fields (io, verify, on_verify_fail) and file-backed stages with uses: ./id.yaml.
Explain Stageflow practice briefly while authoring.`;

export function createWorkshopAuthorProfile(): OperatorAgentProfile {
  return {
    id: WORKSHOP_AUTHOR_PROFILE_ID,
    title: "Workshop Author",
    playbook: WORKSHOP_AUTHOR_PLAYBOOK,
    tools: workshopAuthorTools,
    contextAdapter: workshopDraftContextAdapter,
    greeting: WORKSHOP_AUTHOR_GREETING,
  };
}

export function proposeStageFromUserMessage(
  ctx: OperatorAgentToolContext,
  message: string,
): OperatorAgentProposal {
  const draft = readDraftFromContext(ctx.getContext());
  const proposal = buildStageAddProposal(draft, message);
  ctx.emitProposal(proposal);
  return proposal;
}

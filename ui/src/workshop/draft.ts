export type DraftStageArtifact = {
  path: string;
  body: Record<string, unknown>;
};

export type DraftPackage = {
  pipeline: {
    id: string;
    stages: Array<Record<string, unknown>>;
    agent?: unknown;
    model?: unknown;
    schemas?: unknown;
    requires?: unknown;
  };
  stages?: DraftStageArtifact[];
  task?: {
    filename: string;
    body: Record<string, unknown>;
  };
};

export type WorkshopProposal = {
  id: string;
  summary: string;
  nextDraft: DraftPackage;
};

export type ChatMessage = {
  id: string;
  role: "assistant" | "user" | "system";
  text: string;
};

export const WORKSHOP_AUTHOR_GREETING =
  "What are we building? Describe the workflow you want and I’ll propose stages and wiring for this draft.";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5";

const REQUIRED_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

let proposalSeq = 0;

export function emptyDraftPackage(id = "untitled"): DraftPackage {
  return {
    pipeline: {
      id,
      stages: [],
    },
  };
}

function slugifyStageId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "stage";
}

/** Client-side fake Workshop Author turn — mirrors src/operatorAgent fake host. */
export function proposeStageFromMessage(
  draft: DraftPackage,
  userText: string,
): WorkshopProposal {
  proposalSeq += 1;
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
    id: `proposal-${proposalSeq}`,
    summary: `Add stage “${stageId}”`,
    nextDraft,
  };
}

export function draftStageIds(draft: DraftPackage): string[] {
  return draft.pipeline.stages.map((stage, index) =>
    typeof stage.id === "string" && stage.id ? stage.id : `stage-${index}`,
  );
}

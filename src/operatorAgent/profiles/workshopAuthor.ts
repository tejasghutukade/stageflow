import {
  validateDraftPackage,
  type DraftPackage,
} from "../../config/draftPackage.js";
import {
  createFilesystemDocsRetriever,
  type DocsRetriever,
} from "../docsRetrieval.js";
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
import { WORKSHOP_AUTHOR_PLAYBOOK } from "./workshopAuthorPlaybook.js";

export const WORKSHOP_AUTHOR_PROFILE_ID = "workshop-author";
export { WORKSHOP_AUTHOR_PLAYBOOK };

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

function slugifyTaskId(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "task";
}

function extractQuotedPhrase(text: string): string | null {
  const match = text.match(/["“]([^"”]+)["”]/);
  return match?.[1]?.trim() || null;
}

export function isTaskProposalIntent(message: string): boolean {
  const text = message.trim().toLowerCase();
  if (!text) return false;
  return (
    /\b(create|add|make|attach|fill|set|write)\b[\s\w-]*\btask\b/.test(text) ||
    /\btask\b[\s\w-]*\b(create|add|fill|goal|brief)\b/.test(text) ||
    /\b(task brief|task package|task fields)\b/.test(text)
  );
}

export function buildTaskAddProposal(
  draft: DraftPackage,
  userText: string,
): OperatorAgentProposal {
  const quoted = extractQuotedPhrase(userText);
  const existingId =
    typeof draft.task?.body.id === "string" ? draft.task.body.id : "";
  const existingGoal =
    typeof draft.task?.body.goal === "string" ? draft.task.body.goal : "";

  let taskId = existingId;
  let goal = existingGoal;

  if (quoted) {
    if (!existingId || /\b(create|add|make|attach)\b/i.test(userText)) {
      taskId = slugifyTaskId(quoted);
    }
    goal = quoted;
  } else {
    const goalMatch = userText.match(/\b(?:goal|brief)\s*[:=]\s*(.+)$/i);
    if (goalMatch?.[1]) {
      goal = goalMatch[1].trim();
    } else if (!goal) {
      goal = userText.trim() || "Describe the workflow goal";
    }
    if (!taskId) {
      taskId = slugifyTaskId(
        userText
          .replace(
            /\b(create|add|make|attach|fill|set|write|a|the|task|brief|goal|fields|package)\b/gi,
            " ",
          )
          .trim() || "task",
      );
    }
  }

  if (!taskId) taskId = "task";
  if (!goal) goal = "Describe the workflow goal";

  const filename = `${taskId}.task.yaml`;
  const filling = Boolean(draft.task);
  const nextDraft: DraftPackage = {
    ...draft,
    task: {
      filename,
      body: {
        ...(draft.task?.body ?? {}),
        id: taskId,
        goal,
      },
    },
  };

  return {
    id: nextProposalId(),
    summary: filling ? `Fill task “${taskId}”` : `Create task “${taskId}”`,
    nextContext: nextDraft,
    baseContext: { draft },
    baseFingerprint: draftFingerprint(draft),
    artifacts: diffDraftPackages(draft, nextDraft),
    affectedStageIds: [],
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

function createRetrieveDocsTool(retriever: DocsRetriever): OperatorAgentTool {
  return {
    name: "retrieve_docs",
    description:
      "Retrieve current public Stageflow docs/examples snippets by query. Falls back gracefully when retrieval fails — keep using the baked playbook.",
    async handler(args): Promise<OperatorAgentToolResult> {
      const query =
        typeof args.query === "string" && args.query.trim()
          ? args.query.trim()
          : "";
      if (!query) {
        return { ok: false, content: null, error: "query is required" };
      }
      const kindRaw = typeof args.kind === "string" ? args.kind : "any";
      const kind =
        kindRaw === "docs" || kindRaw === "examples" || kindRaw === "any"
          ? kindRaw
          : "any";
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? args.limit
          : undefined;
      try {
        const result = await retriever.retrieve(query, { kind, limit });
        if (!result.ok) {
          return {
            ok: false,
            content: result,
            error: result.error ?? "docs retrieval failed",
          };
        }
        return { ok: true, content: result };
      } catch (err) {
        return {
          ok: false,
          content: { ok: false, hits: [], error: String(err) },
          error:
            err instanceof Error ? err.message : "docs retrieval failed",
        };
      }
    },
  };
}

export type WorkshopAuthorProfileOptions = {
  retriever?: DocsRetriever;
};

export function createWorkshopAuthorTools(
  retriever: DocsRetriever = createFilesystemDocsRetriever(),
): OperatorAgentTool[] {
  return [
    readDraftTool,
    proposeDraftTool,
    validateDraftTool,
    createRetrieveDocsTool(retriever),
  ];
}

/** Default tool list with filesystem docs/examples retrieval. */
export const workshopAuthorTools: OperatorAgentTool[] =
  createWorkshopAuthorTools();

export function createWorkshopAuthorProfile(
  options: WorkshopAuthorProfileOptions = {},
): OperatorAgentProfile {
  const retriever = options.retriever ?? createFilesystemDocsRetriever();
  return {
    id: WORKSHOP_AUTHOR_PROFILE_ID,
    title: "Workshop Author",
    playbook: WORKSHOP_AUTHOR_PLAYBOOK,
    tools: createWorkshopAuthorTools(retriever),
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

export function proposeTaskFromUserMessage(
  ctx: OperatorAgentToolContext,
  message: string,
): OperatorAgentProposal {
  const draft = readDraftFromContext(ctx.getContext());
  const proposal = buildTaskAddProposal(draft, message);
  ctx.emitProposal(proposal);
  return proposal;
}

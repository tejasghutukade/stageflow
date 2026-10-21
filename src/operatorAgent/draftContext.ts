import type { DraftPackage } from "../config/draftPackage.js";
import type {
  OperatorAgentContextAdapter,
  OperatorAgentProposal,
  WorkshopDraftContext,
} from "./types.js";

export const WORKSHOP_AUTHOR_GREETING =
  "What are we building? Tell me the workflow in your own words — I’ll ask where it changes the draft.";

export function emptyDraftPackage(id = "untitled"): DraftPackage {
  return {
    pipeline: {
      id,
      stages: [],
    },
  };
}

export type WorkshopDraftContextExtras = Omit<WorkshopDraftContext, "draft">;

export function createWorkshopDraftContext(
  draft: DraftPackage = emptyDraftPackage(),
  extras: WorkshopDraftContextExtras = {},
): WorkshopDraftContext {
  return { draft, ...extras };
}

export function isWorkshopDraftContext(
  value: unknown,
): value is WorkshopDraftContext {
  return (
    value !== null &&
    typeof value === "object" &&
    "draft" in value &&
    (value as WorkshopDraftContext).draft !== null &&
    typeof (value as WorkshopDraftContext).draft === "object"
  );
}

export function readDraftFromContext(context: unknown): DraftPackage {
  if (isWorkshopDraftContext(context)) return context.draft;
  if (
    context !== null &&
    typeof context === "object" &&
    "pipeline" in context
  ) {
    return context as DraftPackage;
  }
  return emptyDraftPackage();
}

export function withDraft(
  context: unknown,
  draft: DraftPackage,
): WorkshopDraftContext {
  if (isWorkshopDraftContext(context)) {
    return { ...context, draft };
  }
  return { draft };
}

export function withDestination(
  context: unknown,
  destination: WorkshopDraftContext["destination"],
): WorkshopDraftContext {
  const base = isWorkshopDraftContext(context)
    ? context
    : { draft: readDraftFromContext(context) };
  return { ...base, destination };
}

export function withProjectRoot(
  context: unknown,
  projectRoot: string,
): WorkshopDraftContext {
  const base = isWorkshopDraftContext(context)
    ? context
    : { draft: readDraftFromContext(context) };
  return { ...base, projectRoot };
}

export const workshopDraftContextAdapter: OperatorAgentContextAdapter = {
  serialize(context: unknown): unknown {
    return readDraftFromContext(context);
  },
  applyProposal(
    context: unknown,
    proposal: OperatorAgentProposal,
  ): WorkshopDraftContext {
    const next = proposal.nextContext;
    if (isWorkshopDraftContext(next)) {
      return withDraft(context, next.draft);
    }
    if (next !== null && typeof next === "object" && "pipeline" in next) {
      return withDraft(context, next as DraftPackage);
    }
    return withDraft(context, readDraftFromContext(context));
  },
};

export function draftTrackStages(draft: DraftPackage): Array<{
  id: string;
  label: string;
}> {
  return draft.pipeline.stages.map((stage, index) => {
    const id = typeof stage.id === "string" && stage.id ? stage.id : `stage-${index}`;
    return { id, label: id };
  });
}

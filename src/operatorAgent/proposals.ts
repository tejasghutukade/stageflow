import type { DraftPackage } from "../config/draftPackage.js";
import { readDraftFromContext } from "./draftContext.js";
import type { OperatorAgentProposal } from "./types.js";

export type ProposalArtifactDiff = {
  path: string;
  kind: "added" | "removed" | "modified";
  before?: string;
  after?: string;
};

export type AcceptProposalResult =
  | { ok: true }
  | {
      ok: false;
      reason: "none" | "id_mismatch";
      notice?: string;
    };

export type UndoMutationResult =
  | { ok: true }
  | {
      ok: false;
      reason: "none" | "id_mismatch" | "conflict";
      notice?: string;
    };

const UNDO_CONFLICT_NOTICE =
  "Undo blocked: the draft changed after this mutation. Ask the agent to reverse the change instead of rejecting.";

export function draftFingerprint(draft: DraftPackage): string {
  return JSON.stringify(draft);
}

export function formatArtifact(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function stageIds(draft: DraftPackage): string[] {
  return draft.pipeline.stages.map((stage, index) =>
    typeof stage.id === "string" && stage.id ? stage.id : `stage-${index}`,
  );
}

export function diffDraftPackages(
  before: DraftPackage,
  after: DraftPackage,
): ProposalArtifactDiff[] {
  const diffs: ProposalArtifactDiff[] = [];
  const pipelinePath = `${after.pipeline.id || before.pipeline.id || "pipeline"}.pipeline.yaml`;
  if (JSON.stringify(before.pipeline) !== JSON.stringify(after.pipeline)) {
    diffs.push({
      path: pipelinePath,
      kind: "modified",
      before: formatArtifact(before.pipeline),
      after: formatArtifact(after.pipeline),
    });
  }

  const beforeStages = new Map(
    (before.stages ?? []).map((s) => [s.path, s] as const),
  );
  const afterStages = new Map(
    (after.stages ?? []).map((s) => [s.path, s] as const),
  );

  for (const [path, art] of afterStages) {
    const prev = beforeStages.get(path);
    if (!prev) {
      diffs.push({
        path,
        kind: "added",
        after: formatArtifact(art.body),
      });
    } else if (JSON.stringify(prev.body) !== JSON.stringify(art.body)) {
      diffs.push({
        path,
        kind: "modified",
        before: formatArtifact(prev.body),
        after: formatArtifact(art.body),
      });
    }
  }
  for (const [path, art] of beforeStages) {
    if (!afterStages.has(path)) {
      diffs.push({
        path,
        kind: "removed",
        before: formatArtifact(art.body),
      });
    }
  }

  const beforeTask = before.task
    ? formatArtifact({ filename: before.task.filename, body: before.task.body })
    : null;
  const afterTask = after.task
    ? formatArtifact({ filename: after.task.filename, body: after.task.body })
    : null;
  if (beforeTask !== afterTask) {
    const path =
      after.task?.filename ?? before.task?.filename ?? "task.task.yaml";
    if (!beforeTask && afterTask) {
      diffs.push({ path, kind: "added", after: afterTask });
    } else if (beforeTask && !afterTask) {
      diffs.push({ path, kind: "removed", before: beforeTask });
    } else {
      diffs.push({
        path,
        kind: "modified",
        before: beforeTask ?? undefined,
        after: afterTask ?? undefined,
      });
    }
  }

  return diffs;
}

export function affectedStageIds(
  before: DraftPackage,
  after: DraftPackage,
): string[] {
  const beforeSet = new Set(stageIds(before));
  const afterSet = new Set(stageIds(after));
  const ids = new Set<string>();
  for (const id of afterSet) {
    if (!beforeSet.has(id)) ids.add(id);
  }
  for (const id of beforeSet) {
    if (!afterSet.has(id)) ids.add(id);
  }

  const beforeByPath = new Map(
    (before.stages ?? []).map((s) => [s.path, s] as const),
  );
  for (const art of after.stages ?? []) {
    const prev = beforeByPath.get(art.path);
    if (!prev || JSON.stringify(prev.body) !== JSON.stringify(art.body)) {
      const id =
        typeof art.body.id === "string" && art.body.id
          ? art.body.id
          : undefined;
      if (id) ids.add(id);
    }
  }
  for (const art of before.stages ?? []) {
    if (!(after.stages ?? []).some((s) => s.path === art.path)) {
      const id =
        typeof art.body.id === "string" && art.body.id
          ? art.body.id
          : undefined;
      if (id) ids.add(id);
    }
  }

  for (let i = 0; i < after.pipeline.stages.length; i += 1) {
    const a = after.pipeline.stages[i]!;
    const b = before.pipeline.stages[i];
    const id =
      typeof a.id === "string" && a.id ? a.id : `stage-${i}`;
    if (!b || JSON.stringify(a) !== JSON.stringify(b)) {
      ids.add(id);
    }
  }

  return [...ids];
}

export function enrichProposal(
  proposal: OperatorAgentProposal,
  currentContext: unknown,
): OperatorAgentProposal {
  const baseDraft = readDraftFromContext(
    proposal.baseContext ?? currentContext,
  );
  const nextDraft = readDraftFromContext(proposal.nextContext);
  const baseContext =
    proposal.baseContext ??
    ({ draft: baseDraft } satisfies { draft: DraftPackage });
  return {
    ...proposal,
    baseContext,
    baseFingerprint:
      proposal.baseFingerprint ?? draftFingerprint(baseDraft),
    appliedFingerprint:
      proposal.appliedFingerprint ?? draftFingerprint(nextDraft),
    artifacts:
      proposal.artifacts ?? diffDraftPackages(baseDraft, nextDraft),
    affectedStageIds:
      proposal.affectedStageIds ?? affectedStageIds(baseDraft, nextDraft),
  };
}

/** True when the live draft no longer matches the post-apply fingerprint. */
export function isMutationConflict(
  mutation: OperatorAgentProposal,
  currentContext: unknown,
): boolean {
  const current = draftFingerprint(readDraftFromContext(currentContext));
  if (mutation.appliedFingerprint) {
    return mutation.appliedFingerprint !== current;
  }
  const next = draftFingerprint(readDraftFromContext(mutation.nextContext));
  return next !== current;
}

export const UNDO_MUTATION_CONFLICT_NOTICE = UNDO_CONFLICT_NOTICE;

/** @deprecated Prefer UNDO_MUTATION_CONFLICT_NOTICE — kept for callers mid-migration. */
export const STALE_PROPOSAL_NOTICE = UNDO_CONFLICT_NOTICE;

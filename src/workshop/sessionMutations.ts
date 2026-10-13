import type { ProposalArtifactDiff } from "../operatorAgent/proposals.js";
import type { WorkshopChatProposalPayload } from "./chatTurn.js";

type SnapshotDraft = WorkshopChatProposalPayload["baseDraft"];

export type WorkshopSessionMutationSnapshot = {
  id: string;
  summary: string;
  affectedStageIds: string[];
  artifacts: ProposalArtifactDiff[];
  status: "accepted" | "rejected";
  autoApplied?: boolean;
  baseDraft?: SnapshotDraft;
  nextDraft?: SnapshotDraft;
  baseFingerprint?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseDraft(value: unknown): SnapshotDraft | undefined {
  if (!isPlainObject(value)) return undefined;
  const pipeline = value.pipeline;
  if (!isPlainObject(pipeline)) return undefined;
  if (typeof pipeline.id !== "string") return undefined;
  if (!Array.isArray(pipeline.stages)) return undefined;
  if (pipeline.stages.some((stage) => !isPlainObject(stage))) return undefined;
  if (value.stages !== undefined) {
    if (!Array.isArray(value.stages)) return undefined;
    for (const entry of value.stages) {
      if (
        !isPlainObject(entry) ||
        typeof entry.path !== "string" ||
        !isPlainObject(entry.body)
      ) {
        return undefined;
      }
    }
  }
  if (value.task !== undefined) {
    if (
      !isPlainObject(value.task) ||
      typeof value.task.filename !== "string" ||
      !isPlainObject(value.task.body)
    ) {
      return undefined;
    }
  }
  return structuredClone(value) as SnapshotDraft;
}

function parseArtifact(value: unknown): ProposalArtifactDiff | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.path !== "string" || !value.path) return null;
  if (
    value.kind !== "added" &&
    value.kind !== "removed" &&
    value.kind !== "modified"
  ) {
    return null;
  }
  const artifact: ProposalArtifactDiff = {
    path: value.path,
    kind: value.kind,
  };
  if (typeof value.before === "string") artifact.before = value.before;
  if (typeof value.after === "string") artifact.after = value.after;
  return artifact;
}

export function parseWorkshopSessionMutationSnapshot(
  value: unknown,
): WorkshopSessionMutationSnapshot | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (typeof value.summary !== "string") return null;
  if (!Array.isArray(value.affectedStageIds)) return null;
  const affectedStageIds = value.affectedStageIds.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  if (!Array.isArray(value.artifacts)) return null;
  const artifacts: ProposalArtifactDiff[] = [];
  for (const entry of value.artifacts) {
    const parsed = parseArtifact(entry);
    if (!parsed) return null;
    artifacts.push(parsed);
  }
  const status = value.status === "rejected" ? "rejected" : "accepted";
  const baseDraft = parseDraft(value.baseDraft);
  const nextDraft = parseDraft(value.nextDraft);
  const baseFingerprint =
    typeof value.baseFingerprint === "string" && value.baseFingerprint
      ? value.baseFingerprint
      : undefined;
  return {
    id: value.id,
    summary: value.summary,
    affectedStageIds,
    artifacts,
    status,
    ...(value.autoApplied === true ? { autoApplied: true } : {}),
    ...(baseDraft ? { baseDraft } : {}),
    ...(nextDraft ? { nextDraft } : {}),
    ...(baseFingerprint ? { baseFingerprint } : {}),
  };
}

export function mutationSnapshotsFromProposals(
  proposals: readonly WorkshopChatProposalPayload[],
  autoApply: boolean,
): WorkshopSessionMutationSnapshot[] {
  return proposals.map((proposal) => ({
    id: proposal.id,
    summary: proposal.summary,
    affectedStageIds: [...proposal.affectedStageIds],
    artifacts: proposal.artifacts.map((artifact) => ({ ...artifact })),
    status: "accepted" as const,
    baseDraft: structuredClone(proposal.baseDraft),
    nextDraft: structuredClone(proposal.nextDraft),
    ...(proposal.baseFingerprint
      ? { baseFingerprint: proposal.baseFingerprint }
      : {}),
    ...(autoApply ? { autoApplied: true } : {}),
  }));
}

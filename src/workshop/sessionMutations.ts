import type { ProposalArtifactDiff } from "../operatorAgent/proposals.js";
import type { WorkshopChatProposalPayload } from "./chatTurn.js";

export type WorkshopSessionMutationSnapshot = {
  id: string;
  summary: string;
  affectedStageIds: string[];
  artifacts: ProposalArtifactDiff[];
  status: "accepted" | "rejected";
  autoApplied?: boolean;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
  return {
    id: value.id,
    summary: value.summary,
    affectedStageIds,
    artifacts,
    status,
    ...(value.autoApplied === true ? { autoApplied: true } : {}),
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
    status: "accepted",
    ...(autoApply ? { autoApplied: true } : {}),
  }));
}

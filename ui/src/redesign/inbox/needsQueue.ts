import type { RunSummary } from "../../api";
import type { AgentApproval } from "../../api/agents";

export type AgentApprovalItem = AgentApproval & { agentId: string; agentName?: string };

/** One thing waiting on a person: a pipeline gate or an agent's ask-first approval. */
export type NeedsItem =
  | { kind: "run"; key: string; at: string; run: RunSummary }
  | { kind: "agent"; key: string; at: string; approval: AgentApprovalItem };

export function agentApprovalKey(approvalId: string): string {
  return `agent:${approvalId}`;
}

/** Longest-waiting first, the order the Inbox already used for gates. Gates come before approvals on a tie. */
export function mergeNeedsQueue(runs: RunSummary[], approvals: AgentApprovalItem[]): NeedsItem[] {
  const items: NeedsItem[] = [
    ...runs.map((run): NeedsItem => ({ kind: "run", key: run.run_id, at: run.updated_at ?? run.created_at, run })),
    ...approvals.map((approval): NeedsItem => ({ kind: "agent", key: agentApprovalKey(approval.id), at: approval.createdAt, approval })),
  ];
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.at.localeCompare(b.item.at) || a.index - b.index)
    .map(({ item }) => item);
}

/** A one-line preview of what the agent wants to run. */
export function approvalPreview(payload: Record<string, unknown>, max = 140): string {
  const text = JSON.stringify(payload);
  if (!text || text === "{}") return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

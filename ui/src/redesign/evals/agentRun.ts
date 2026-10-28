import type { EvalRunDetail } from "../../api/evalTypes";

type Snapshot = Record<string, any>;

function targetOf(run: Pick<EvalRunDetail, "config">): Snapshot {
  return (run.config?.target ?? {}) as Snapshot;
}

export function isAgentRun(run: Pick<EvalRunDetail, "config">): boolean {
  return targetOf(run).kind === "agent";
}

export function isConversationTarget(run: Pick<EvalRunDetail, "config">): boolean {
  const kind = targetOf(run).kind;
  return kind === "agent" || kind === "internal_agent";
}

export function targetModelOf(run: Pick<EvalRunDetail, "config">): string | null {
  if (!isConversationTarget(run)) return null;
  const model = targetOf(run).model;
  return typeof model === "string" && model !== "" ? model : null;
}

export function internalAgentLabel(run: Pick<EvalRunDetail, "config">): string | null {
  const target = targetOf(run);
  if (target.kind !== "internal_agent") return null;
  if (typeof target.title === "string" && target.title !== "") return target.title;
  return typeof target.profile_id === "string" && target.profile_id !== "" ? target.profile_id : null;
}

export function agentIdOf(run: Pick<EvalRunDetail, "config">): string | null {
  const id = targetOf(run).agent_id;
  return typeof id === "string" && id !== "" ? id : null;
}

export function agentRevisionOf(run: Pick<EvalRunDetail, "config">): number | null {
  const revision = targetOf(run).revision;
  return typeof revision === "number" ? revision : null;
}

/** The agent's name from the snapshotted definition, else its id. */
export function agentNameOf(run: Pick<EvalRunDetail, "config">): string | null {
  const name = targetOf(run).definition?.name;
  if (typeof name === "string" && name !== "") return name;
  return agentIdOf(run);
}

export function conversationOf(run: Pick<EvalRunDetail, "config">): Snapshot {
  return ((run.config?.settings ?? {}) as Snapshot).conversation ?? {};
}

/** `Agent support r4` */
export function agentRunLabel(run: Pick<EvalRunDetail, "config">): string | null {
  const name = agentNameOf(run);
  if (!name) return null;
  const revision = agentRevisionOf(run);
  return revision === null ? `Agent ${name}` : `Agent ${name} r${revision}`;
}

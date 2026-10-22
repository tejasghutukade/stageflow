import type { AgentSessionDetail } from "../../../api/agents";
import type { EvalCaseInput, EvalDatasetListItem } from "../../../api/evalTypes";

const SCRIPT_MAX_MESSAGES = 40;
const SCRIPT_MAX_CHARS = 4000;
export const FROM_SESSION_TAG = "from-session";
export const NEW_DATASET = "__new__";

export type SessionScenario = EvalCaseInput & { id: string };

export function userMessages(detail: AgentSessionDetail): string[] {
  return detail.messages
    .filter((m) => m.role === "user" && m.text.trim() !== "")
    .map((m) => m.text.slice(0, SCRIPT_MAX_CHARS))
    .slice(0, SCRIPT_MAX_MESSAGES);
}

export function toolNames(detail: AgentSessionDetail): string[] {
  const names = new Set<string>();
  for (const span of detail.spans) {
    if (span.kind !== "tool") continue;
    const name = span.attributes["gen_ai.tool.name"];
    if (typeof name === "string" && name !== "") names.add(name);
  }
  return [...names];
}

export function sessionShortId(sessionId: string): string {
  return sessionId.replace(/^ses_/, "").slice(0, 8);
}

/** Eval sessions never get the action. */
export function canOfferAddAsCase(detail: AgentSessionDetail | null): boolean {
  return detail !== null && detail.session.source !== "eval";
}

/** Why the action is disabled, or null when it can be used. */
export function addAsCaseDisabledReason(detail: AgentSessionDetail): string | null {
  const lastTurn = detail.turns[detail.turns.length - 1];
  if (
    detail.session.status === "running" ||
    detail.session.status === "waiting" ||
    lastTurn?.status === "running" ||
    lastTurn?.status === "waiting"
  ) {
    return "Wait for the session to finish";
  }
  if (userMessages(detail).length === 0) return "This session has no messages";
  return null;
}

/** A script scenario from the session's user messages. The author edits it before saving. */
export function scenarioFromSession(detail: AgentSessionDetail): SessionScenario | null {
  const script = userMessages(detail);
  if (script.length === 0) return null;
  const short = sessionShortId(detail.session.id);
  return {
    id: `session-${short}`,
    title: detail.session.title ?? `Session ${short}`,
    input: { mode: "script", script, opening: script[0] },
    expected: { tools: toolNames(detail) },
    tags: [FROM_SESSION_TAG],
    metadata: { source_session: detail.session.id },
  };
}

export type DatasetChoice = { id: string; label: string; hash: string; projectRoot?: string; forAgent: boolean };

/** Editable datasets, those used by the agent's evals first. */
export function datasetChoices(datasets: EvalDatasetListItem[], agentEvalIds: readonly string[]): DatasetChoice[] {
  const choices = datasets
    .filter((d) => d.editable)
    .map((d) => ({
      id: d.id,
      label: d.id,
      hash: d.hash,
      ...(d.project_root ? { projectRoot: d.project_root } : {}),
      forAgent: d.used_by.some((e) => agentEvalIds.includes(e)),
    }));
  return choices.sort((a, b) => Number(b.forAgent) - Number(a.forAgent));
}

export function defaultDatasetName(agentId: string, takenNames: readonly string[]): string {
  const slug = agentId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const base = `${slug}-scenarios`.slice(0, 60);
  if (!takenNames.includes(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!takenNames.includes(candidate)) return candidate;
  }
}

export const DATASET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function datasetNameError(name: string, takenNames: readonly string[]): string | null {
  if (!DATASET_NAME_PATTERN.test(name)) return "Use letters, digits, . _ - (max 64)";
  if (takenNames.includes(name)) return "A dataset with this name exists";
  return null;
}

export function scenarioSummary(c: EvalCaseInput): string {
  const input = (c.input ?? {}) as { script?: unknown };
  const n = Array.isArray(input.script) ? input.script.length : 0;
  const tools = ((c.expected ?? {}) as { tools?: unknown }).tools;
  const toolCount = Array.isArray(tools) ? tools.length : 0;
  return `${n} ${n === 1 ? "message" : "messages"} · ${toolCount} expected ${toolCount === 1 ? "tool" : "tools"}`;
}

import type {
  EvalAgentTool,
  EvalConversation,
  EvalConversationApprovals,
  EvalConversationMode,
  EvalConversationTools,
  EvalRunEstimate,
} from "../../../api/evalTypes";

export const DEFAULT_MAX_TURNS = 8;
export const DEFAULT_TURN_TIMEOUT_SEC = 120;
export const MIN_MAX_TURNS = 1;
export const MAX_MAX_TURNS = 30;
export const MIN_TURN_TIMEOUT_SEC = 5;
export const MAX_TURN_TIMEOUT_SEC = 600;
export const MAX_READ_ONLY_TOOLS = 50;
export const AGENT_DEFAULT_MAX_COST_USD = 1;
export const AGENT_DEFAULT_CONCURRENCY = 2;
export const STUBBED_NAMES_SHOWN = 5;

export type ConversationDraft = {
  mode: EvalConversationMode;
  maxTurns: number;
  turnTimeoutSec: number;
  /** `null` is "Same as judge". */
  userModel: string | null;
  tools: EvalConversationTools;
  approvals: EvalConversationApprovals;
  readOnlyTools: string[];
  allowReal: boolean;
};

export function initialConversation(): ConversationDraft {
  return {
    mode: "script",
    maxTurns: DEFAULT_MAX_TURNS,
    turnTimeoutSec: DEFAULT_TURN_TIMEOUT_SEC,
    userModel: null,
    tools: "read_only",
    approvals: "record_only",
    readOnlyTools: [],
    allowReal: false,
  };
}

export const MODE_OPTIONS: Array<{ value: EvalConversationMode; label: string }> = [
  { value: "script", label: "Script" },
  { value: "simulated", label: "Simulated" },
];
export const MODE_HELPER = "Script plays fixed user messages. Simulated lets a model play the user from a persona and goal.";
export const MAX_TURNS_HELPER = "User turns per case. Reaching it is not a failure.";
export const USER_MODEL_HELPER = "Plays the user. Costs tokens on every turn.";
export const USER_MODEL_DEFAULT_LABEL = "Same as judge";
export const READ_ONLY_TOOLS_HELPER = "Tools not listed as read-only are stubbed.";
export const LIMITS_NOTE = "Eval limits replace the agent's own limits for these runs. The agent file is not changed.";

export const TOOLS_OPTIONS: Array<{ value: EvalConversationTools; label: string; body: string }> = [
  {
    value: "read_only",
    label: "Read only",
    body: "The agent can read. Anything that writes, runs commands or calls outside services is not executed: the agent is told it was not run, and the call is recorded.",
  },
  {
    value: "mocked",
    label: "Mocked",
    body: "Only tools with a mock in the scenario return its canned result; reading tools run; everything else is not executed. Mocks reach the agent as error-flagged results, so behavior is approximate.",
  },
  {
    value: "real",
    label: "Real",
    body: "Every tool runs for real on this machine. Selecting it shows a warning that must be acknowledged.",
  },
];

export const APPROVALS_OPTIONS: Array<{ value: EvalConversationApprovals; label: string }> = [
  { value: "record_only", label: "Record only" },
  { value: "deny", label: "Deny" },
  { value: "auto_approve_read", label: "Auto-approve reads" },
];
export const APPROVALS_NOTE: Record<EvalConversationApprovals, string> = {
  record_only: "Calls that would ask first are recorded and denied. Nothing reaches the Inbox.",
  deny: "Calls that would ask first are denied by policy. Nothing reaches the Inbox.",
  auto_approve_read: "Reading calls that would ask first are approved and run. Everything else is recorded and denied.",
};

export const REAL_WARNING_LEAD = "Real tools can change your project.";
export const REAL_WARNING_BODY =
  "Every tool this agent has will run for real on this machine, including write, shell and outside services. Use a throwaway copy of the project, or switch to Read only.";
export const REAL_CONSENT_LABEL = "I understand";
export const REAL_BLOCKED_NOTE = "Create is blocked until you tick I understand. (eval.real_tools_not_allowed)";
export const REAL_REVIEW_NOTE = "Real tools are on. Every run of this eval can change files and call outside services.";
export const REAL_CHIP = "REAL TOOLS";

export type ConversationErrors = { maxTurns?: string; turnTimeout?: string; readOnlyTools?: string };

export function conversationErrors(c: ConversationDraft): ConversationErrors {
  const out: ConversationErrors = {};
  if (!Number.isInteger(c.maxTurns) || c.maxTurns < MIN_MAX_TURNS || c.maxTurns > MAX_MAX_TURNS) {
    out.maxTurns = `Max turns must be a whole number from ${MIN_MAX_TURNS} to ${MAX_MAX_TURNS}`;
  }
  if (!Number.isInteger(c.turnTimeoutSec) || c.turnTimeoutSec < MIN_TURN_TIMEOUT_SEC || c.turnTimeoutSec > MAX_TURN_TIMEOUT_SEC) {
    out.turnTimeout = `Turn timeout must be a whole number of seconds from ${MIN_TURN_TIMEOUT_SEC} to ${MAX_TURN_TIMEOUT_SEC}`;
  }
  if (c.readOnlyTools.length > MAX_READ_ONLY_TOOLS) out.readOnlyTools = `At most ${MAX_READ_ONLY_TOOLS} tools`;
  const bad = c.readOnlyTools.find((t) => !TOOL_ID_PATTERN.test(t));
  if (bad !== undefined) out.readOnlyTools = `"${bad}" is not a tool id (use server.tool or server.*)`;
  return out;
}

export const TOOL_ID_PATTERN = /^[^\s]{1,128}$/;

export function conversationValid(c: ConversationDraft): boolean {
  return Object.keys(conversationErrors(c)).length === 0;
}

export function realToolsPending(c: ConversationDraft): boolean {
  return c.tools === "real" && !c.allowReal;
}

export function setTools(c: ConversationDraft, tools: EvalConversationTools): ConversationDraft {
  return { ...c, tools, allowReal: tools === "real" ? c.allowReal : false };
}

/** The `conversation` block exactly as the file schema writes it: all five basics, the rest only when non-default. */
export function toConversation(c: ConversationDraft): EvalConversation {
  return {
    mode: c.mode,
    max_turns: c.maxTurns,
    turn_timeout_ms: c.turnTimeoutSec * 1000,
    tools: c.tools,
    approvals: c.approvals,
    ...(c.readOnlyTools.length > 0 ? { read_only_tools: [...c.readOnlyTools] } : {}),
    ...(c.tools === "real" && c.allowReal ? { allow_real_tools: true } : {}),
  };
}

/** The `defaults.user_model` value: only a simulated conversation names one. */
export function userModelOf(c: ConversationDraft): string | undefined {
  return c.mode === "simulated" && c.userModel ? c.userModel : undefined;
}

export function fromConversation(conv: EvalConversation | undefined, userModel: string | undefined): ConversationDraft {
  const base = initialConversation();
  if (!conv) return { ...base, userModel: userModel ?? null };
  return {
    mode: conv.mode ?? base.mode,
    maxTurns: conv.max_turns ?? base.maxTurns,
    turnTimeoutSec: conv.turn_timeout_ms !== undefined ? Math.round(conv.turn_timeout_ms / 1000) : base.turnTimeoutSec,
    userModel: userModel ?? null,
    tools: conv.tools ?? base.tools,
    approvals: conv.approvals ?? base.approvals,
    readOnlyTools: conv.read_only_tools ? [...conv.read_only_tools] : [],
    allowReal: conv.allow_real_tools === true,
  };
}

const TOOLS_WORDS: Record<EvalConversationTools, string> = { read_only: "read only", mocked: "mocked", real: "real" };
const APPROVALS_WORDS: Record<EvalConversationApprovals, string> = {
  record_only: "recorded",
  deny: "denied",
  auto_approve_read: "reads auto-approved",
};

/** `Simulated · up to 8 turns · tools read only · approvals recorded` (run dialog, review). */
export function conversationSummary(conv: EvalConversation | undefined): string {
  const mode = conv?.mode ?? "script";
  const turns = conv?.max_turns ?? DEFAULT_MAX_TURNS;
  const tools = conv?.tools ?? "read_only";
  const approvals = conv?.approvals ?? "record_only";
  return `${mode === "simulated" ? "Simulated" : "Script"} · up to ${turns} turns · tools ${TOOLS_WORDS[tools]} · approvals ${APPROVALS_WORDS[approvals]}`;
}

function listed(toolId: string, readOnlyTools: readonly string[]): boolean {
  return readOnlyTools.some((entry) => entry === toolId || (entry.endsWith(".*") && toolId.startsWith(entry.slice(0, -1))));
}

/** Tools that would be stubbed under Read only: not a read-class tool and not declared read-only. */
export function stubbedTools(tools: readonly EvalAgentTool[], readOnlyTools: readonly string[]): string[] {
  return tools.filter((t) => t.class !== "read" && !listed(t.id, readOnlyTools)).map((t) => t.id);
}

export function stubbedHint(tools: readonly EvalAgentTool[], readOnlyTools: readonly string[]): string | null {
  const names = stubbedTools(tools, readOnlyTools);
  if (names.length === 0) return null;
  const shown = names.slice(0, STUBBED_NAMES_SHOWN).join(", ");
  const tail = names.length > STUBBED_NAMES_SHOWN ? ", ..." : "";
  return `${names.length} of this agent's tools are not read-only and will be stubbed: ${shown}${tail}`;
}

export type EstimateLine = { label: string; value: string };

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const ROUGH_ESTIMATE = "Rough estimate from typical conversations";

/** Agent turns / Simulator / Judge lines from the API's call counts. */
export function agentEstimateLines(estimate: Pick<EvalRunEstimate, "stage_calls" | "simulator_calls" | "judge_calls"> | null): EstimateLine[] {
  if (!estimate) return [];
  return [
    { label: "Agent turns", value: plural(estimate.stage_calls, "conversation", "conversations") },
    { label: "Simulator", value: plural(estimate.simulator_calls ?? 0, "call", "calls") },
    { label: "Judge", value: plural(estimate.judge_calls, "call", "calls") },
  ];
}

export function estimateBasisText(estimate: Pick<EvalRunEstimate, "estimate_basis" | "based_on_run_number"> | null): string | null {
  if (!estimate) return null;
  if (estimate.estimate_basis === "assumptions") return ROUGH_ESTIMATE;
  if (estimate.based_on_run_number !== null) return `Based on run #${estimate.based_on_run_number}`;
  return null;
}

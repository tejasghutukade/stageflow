import type { AgentDefinition } from "../../config/loadAgent.js";
import type { ConsumerRuntimeTool } from "../../identity/types.js";
import { stageflowGrantId, TOOL_META } from "../../toolkit/meta.js";

export type ConversationMessage = { role: "user" | "assistant"; text: string };

/** One tool call by its grant id: a builtin name, `<server>.<tool>`, or `agent:<id>`. */
export type ToolCall = { id: string; tool: string; input: Record<string, unknown> };

export type GateDecision = { allow: true } | { allow: false; reason: string; stopTurn?: boolean };

export type RuntimeUsage = { inputTokens: number; outputTokens: number; costUsd: number };

/** What the runtime reports back to the conversation while a turn runs. */
export type TurnHooks = {
  /** Called before every tool call: grants, write guards, and ask-first approval. */
  gate(call: ToolCall): Promise<GateDecision>;
  toolStarted(call: ToolCall): void;
  toolFinished(call: ToolCall, result: { ok: boolean; output: string }): void;
  modelFinished(info: { startedAt: Date; endedAt: Date; inputTokens: number; outputTokens: number; costUsd: number; model?: string }): void;
  /** Run another agent for a `agent:<id>` call and return its reply. */
  delegate(agentId: string, message: string, callId?: string): Promise<string>;
};

export type CompleteInput = {
  sessionId: string;
  projectRoot: string;
  definition: AgentDefinition;
  /** Prior transcript followed by the new user message. */
  messages: ConversationMessage[];
  signal: AbortSignal;
  onDelta: (text: string) => void;
  hooks: TurnHooks;
  consumerTools?: ConsumerRuntimeTool[];
  /** Sub-agents already checked as consumer-safe. Ambient sub-agents stay off the consumer turn. */
  consumerSafeSubAgents?: readonly string[];
};

export type CompleteResult = { text: string; usage?: RuntimeUsage; toolOutputs: string[] };

export type ConversationBackend = {
  id: "pi" | "claude";
  complete(input: CompleteInput): Promise<CompleteResult>;
  /** One-shot judgement with no tools (groundedness scoring). */
  judge?(input: {
    projectRoot: string;
    definition: AgentDefinition;
    prompt: string;
    /** Replaces the default "strict evaluator" system prompt. */
    systemPrompt?: string;
    signal: AbortSignal;
  }): Promise<string>;
  /** Drop any cached model session for a conversation session. */
  release?(sessionId: string): Promise<void>;
  dispose?(): Promise<void>;
};

export const BUILTIN_TOOL_GROUP_OF: Record<string, "read" | "write" | "shell"> = {
  read: "read",
  grep: "read",
  find: "read",
  ls: "read",
  write: "write",
  edit: "write",
  bash: "shell",
};

/** Pi tool names for Stageflow's own tools are `stageflow_<tool>`. */
export const STAGEFLOW_PI_PREFIX = "stageflow_";

/** Map a Pi tool name to its grant id given the granted MCP servers and sub-agents. */
export function grantIdForPiTool(piTool: string, mcpServers: readonly string[], subAgents: readonly string[]): string {
  if (piTool in BUILTIN_TOOL_GROUP_OF) return piTool;
  if (piTool.startsWith(STAGEFLOW_PI_PREFIX) && piTool.slice(STAGEFLOW_PI_PREFIX.length) in TOOL_META) return stageflowGrantId(piTool.slice(STAGEFLOW_PI_PREFIX.length));
  const agentMatch = /^agent_(.+)$/.exec(piTool);
  if (agentMatch && subAgents.includes(agentMatch[1]!)) return `agent:${agentMatch[1]}`;
  const server = [...mcpServers].sort((a, b) => b.length - a.length).find((name) => piTool.startsWith(`${name}_`));
  if (server) return `${server}.${piTool.slice(server.length + 1)}`;
  return piTool;
}

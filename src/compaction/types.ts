/**
 * Shared contracts for Stageflow's built-in compaction (docs/plans/compaction-strategy.md).
 * Pure data types only: the layers (mask, pin, state, summary, guards) import from here.
 */

export type PinnedFactKind = "id" | "number" | "timestamp" | "url" | "path" | "error" | "other";

/** A value copied verbatim out of a message so a summary cannot lose or reword it. */
export type PinnedFact = {
  kind: PinnedFactKind;
  /** The exact text, e.g. "INC-4471", "48211", "2026-03-14T05:52:03Z". */
  value: string;
  /** A short verbatim snippet around the value (single line, capped), for orientation. */
  context: string;
  /** Position in the message list the facts were extracted from, and the tool when from a tool result. */
  source: { messageIndex: number; toolName?: string };
};

/** A tool result replaced by a placeholder in the model's context. */
export type ClearedResult = {
  toolName: string;
  toolCallId: string;
  /** Where the full output can be read again (a file path or a tool + args hint). */
  recoverHint: string;
  bytes: number;
  /** One line describing what the result was, for the recovery index. */
  descriptor: string;
};

export type WorkingStateKind = "fact" | "decision" | "progress" | "todo" | "blocker";

/** One keyed entry in the model's working state (the `working_state` tool). */
export type WorkingStateEntry = {
  key: string;
  kind: WorkingStateKind;
  value: string;
  updatedAt: string;
};

export const WORKING_STATE_TOOL_NAME = "working_state";

/** Everything the compaction summary is built from, besides the model-written part. */
export type CompactionSections = {
  pinned: readonly PinnedFact[];
  cleared: readonly ClearedResult[];
  state: readonly WorkingStateEntry[];
};

/** Bumped whenever the focus prompt or section layout changes (like RUBRIC_PROMPT_VERSION). */
export const COMPACTION_PROMPT_VERSION = 1;

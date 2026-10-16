import { randomBytes } from "node:crypto";
import { redactSecrets } from "../agent/streamLogRedact.js";
import type { AgentTraceCapture } from "../config/loadAgent.js";
import type { AgentSpan } from "./store.js";

export type SpanKind = "agent" | "model" | "tool" | "sub_agent" | "guardrail" | "gate" | "internal";
export type SpanStatus = "ok" | "error" | "cancelled";

export type SpanDraft = {
  turnId: string;
  parentSpanId?: string | null;
  name: string;
  kind: SpanKind;
  status: SpanStatus;
  startedAt: Date;
  endedAt?: Date;
  usage?: { inputTokens?: number; outputTokens?: number };
  attributes?: Record<string, unknown>;
  input?: string;
  output?: string;
};

/**
 * Apply the revision's capture mode to a span before it is stored:
 * `off` records nothing, `metadata` drops prompt/argument/result bodies, and
 * `full` keeps them after secret redaction. Redaction happens here, before
 * storage, so export never sees an unredacted body.
 */
export function prepareSpan(capture: AgentTraceCapture, draft: SpanDraft): AgentSpan | null {
  if (capture === "off") return null;
  const full = capture === "full";
  return {
    id: randomBytes(8).toString("hex"),
    turnId: draft.turnId,
    parentSpanId: draft.parentSpanId ?? null,
    name: draft.name,
    kind: draft.kind,
    status: draft.status,
    startedAt: draft.startedAt.toISOString(),
    endedAt: draft.endedAt?.toISOString() ?? null,
    durationMs: draft.endedAt ? Math.max(0, draft.endedAt.getTime() - draft.startedAt.getTime()) : null,
    inputTokens: draft.usage?.inputTokens ?? null,
    outputTokens: draft.usage?.outputTokens ?? null,
    attributes: draft.attributes ?? {},
    inputText: full && draft.input !== undefined ? redactSecrets(draft.input) : null,
    outputText: full && draft.output !== undefined ? redactSecrets(draft.output) : null,
  };
}

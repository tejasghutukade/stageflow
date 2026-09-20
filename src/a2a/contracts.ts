import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export type ApplicationErrorCategory =
  | "invalid-input"
  | "unknown-capability"
  | "busy"
  | "message-conflict"
  | "stale-question"
  | "export-failed"
  | "not-found";

export class A2aApplicationError extends Error {
  constructor(
    readonly category: ApplicationErrorCategory,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = "A2aApplicationError";
  }
}

const invokeDataPart = z.object({
  contractVersion: z.literal(1),
  operation: z.literal("invoke"),
  capability: z.string().min(1),
  input: z.unknown(),
});

const freeTextAnswerPayload = z.object({
  kind: z.literal("free_text"),
  text: z.string(),
});

const answerDataPart = z.object({
  contractVersion: z.literal(1),
  operation: z.literal("answer"),
  prompt: z.string().min(1),
  answer: freeTextAnswerPayload,
});

/**
 * Same shape as TaskFile (src/types/task.ts), duplicated locally the same way
 * src/mcp/catalogTools.ts's own taskFileSchema is: deliberately not shared
 * across module boundaries for a schema this small.
 */
const taskFileSchema = z.object({
  id: z.string(),
  goal: z.string(),
  context: z.string().optional(),
  constraints: z.string().optional(),
  checkout: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
});

const envelopeRefSchema = z.object({
  runId: z.string().min(1),
  stageId: z.string().min(1),
  attempt: z.number().int().positive().optional(),
});

/**
 * ADR-0001's wildcard-access operation: invokes any catalog or inline
 * stage/pipeline directly, bypassing the `publications`/`allowed_callers`
 * allowlist that `invoke` enforces. Mirrors run_stage's MCP call shape
 * (src/mcp/catalogTools.ts) closely on purpose so a harness gets the same
 * capability over A2A that it gets over MCP/CLI.
 */
const runStageDataPart = z
  .object({
    contractVersion: z.literal(1),
    operation: z.literal("run_stage"),
    stage: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional(),
    pipeline: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional(),
    task_path: z.string().optional(),
    task: taskFileSchema.optional(),
    envelope_ref: envelopeRefSchema.optional(),
    checkout: z.string().optional(),
    model: z.string().optional(),
    blocking: z.boolean().optional(),
    timeout_ms: z.number().optional(),
  })
  .refine((data) => [data.stage, data.pipeline].filter((v) => v !== undefined).length === 1, {
    message: "Exactly one of stage or pipeline is required",
  })
  .refine(
    (data) => [data.task_path, data.task, data.envelope_ref].filter((v) => v !== undefined).length === 1,
    { message: "Exactly one of task_path, task, or envelope_ref is required" },
  );

const dataPart = z.union([invokeDataPart, answerDataPart, runStageDataPart]);

export type InvokeCommand = {
  kind: "invoke";
  messageId: string;
  contextId?: string;
  capability: string;
  input: unknown;
};

export type AnswerCommand = {
  kind: "answer";
  messageId: string;
  contextId?: string;
  taskId: string;
  handle: string;
  answer: { kind: "free_text"; text: string };
};

export type TaskFileInput = z.infer<typeof taskFileSchema>;
export type EnvelopeRefInput = z.infer<typeof envelopeRefSchema>;

/**
 * ADR-0001's wildcard-access operation. Unlike InvokeCommand, `stage`/`pipeline`
 * name the target directly (a catalog path or an inline body) instead of a
 * published capability id, so no publication/allowlist lookup is possible or
 * required to route it.
 */
export type RunStageCommand = {
  kind: "run_stage";
  messageId: string;
  contextId?: string;
  stage?: string | Record<string, unknown>;
  pipeline?: string | Record<string, unknown>;
  task_path?: string;
  task?: TaskFileInput;
  envelope_ref?: EnvelopeRefInput;
  checkout?: string;
  model?: string;
  blocking?: boolean;
  timeout_ms?: number;
};

export type ValidatedMessage = InvokeCommand | AnswerCommand | RunStageCommand;

export type IncomingMessage = {
  messageId: string;
  contextId?: string;
  taskId?: string;
  parts: Array<{
    content?: { $case: "data"; value: unknown } | { $case: string; value: unknown };
  }>;
};

export function parseIncomingMessage(message: IncomingMessage): ValidatedMessage {
  const dataParts = message.parts.filter(
    (part): part is { content: { $case: "data"; value: unknown } } => part.content?.$case === "data",
  );
  if (dataParts.length !== 1) {
    throw new A2aApplicationError(
      "invalid-input",
      "Message must carry exactly one structured data part with the invoke/answer contract",
    );
  }
  const parsed = dataPart.safeParse(dataParts[0].content.value);
  if (!parsed.success) {
    throw new A2aApplicationError(
      "invalid-input",
      "Message data part does not match the invoke/answer contract: " + parsed.error.message,
    );
  }
  if (parsed.data.operation === "invoke") {
    return {
      kind: "invoke",
      messageId: message.messageId,
      contextId: message.contextId || undefined,
      capability: parsed.data.capability,
      input: parsed.data.input,
    };
  }
  if (parsed.data.operation === "run_stage") {
    return {
      kind: "run_stage",
      messageId: message.messageId,
      contextId: message.contextId || undefined,
      stage: parsed.data.stage,
      pipeline: parsed.data.pipeline,
      task_path: parsed.data.task_path,
      task: parsed.data.task,
      envelope_ref: parsed.data.envelope_ref,
      checkout: parsed.data.checkout,
      model: parsed.data.model,
      blocking: parsed.data.blocking,
      timeout_ms: parsed.data.timeout_ms,
    };
  }
  if (!message.taskId) {
    throw new A2aApplicationError("invalid-input", "An answer message must reference its task");
  }
  return {
    kind: "answer",
    messageId: message.messageId,
    contextId: message.contextId || undefined,
    taskId: message.taskId,
    handle: parsed.data.prompt,
    answer: parsed.data.answer,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function submissionKeyFor(callerId: string, capability: string, hash: string): string {
  return "a2a:" + callerId + ":" + capability + ":" + hash;
}

const HANDLE_SEPARATOR = ":";

export function encodePromptHandle(taskId: string, stageId: string, promptId: string): string {
  return Buffer.from([taskId, stageId, promptId].join(HANDLE_SEPARATOR), "utf8").toString("base64url");
}

export function decodePromptHandle(handle: string): { taskId: string; stageId: string; promptId: string } | undefined {
  let decoded: string;
  try {
    decoded = Buffer.from(handle, "base64url").toString("utf8");
  } catch {
    return undefined;
  }
  const parts = decoded.split(HANDLE_SEPARATOR);
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return undefined;
  const taskId = parts[0];
  const stageId = parts[1];
  const promptId = parts[2];
  return { taskId, stageId, promptId };
}

export function newTaskId(): string {
  return randomUUID();
}

export function newContextId(): string {
  return randomUUID();
}

export function newArtifactId(): string {
  return randomUUID();
}

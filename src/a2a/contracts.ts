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

const dataPart = z.union([invokeDataPart, answerDataPart]);

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

export type ValidatedMessage = InvokeCommand | AnswerCommand;

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

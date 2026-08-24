/**
 * Shared ask-operator prompt/answer vocabulary and tool factory (T2).
 *
 * Types, TypeBox schemas, and validators have no Pi or RunStore dependency.
 * The factory blocks on an injected wait bridge; adapter registration is U3.
 *
 * Do not abort the session from inside `execute`: the tool Promise is the
 * live blocking surface until the operator answers (or stage teardown).
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";

export class AskOperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AskOperatorError";
  }
}

export const ASK_OPERATOR_KINDS = [
  "free_text",
  "confirm",
  "multi_question",
  "artifact_backed",
] as const;

export type AskOperatorKind = (typeof ASK_OPERATOR_KINDS)[number];

export type SubQuestionKind = "free_text" | "confirm";

export type FreeTextPromptParams = {
  kind: "free_text";
  message: string;
  id?: string;
};

export type ConfirmPromptParams = {
  kind: "confirm";
  message: string;
  id?: string;
};

export type MultiQuestionItemParams = {
  kind: SubQuestionKind;
  message: string;
  id?: string;
};

export type MultiQuestionPromptParams = {
  kind: "multi_question";
  questions: MultiQuestionItemParams[];
  id?: string;
};

export type ArtifactBackedPromptParams = {
  kind: "artifact_backed";
  message: string;
  artifacts: string[];
  id?: string;
};

export type AskOperatorParams =
  | FreeTextPromptParams
  | ConfirmPromptParams
  | MultiQuestionPromptParams
  | ArtifactBackedPromptParams;

export type MultiQuestionItem = {
  kind: SubQuestionKind;
  message: string;
  id: string;
};

export type AskOperatorPrompt =
  | { kind: "free_text"; message: string; id: string }
  | { kind: "confirm"; message: string; id: string }
  | {
      kind: "multi_question";
      id: string;
      questions: MultiQuestionItem[];
    }
  | {
      kind: "artifact_backed";
      message: string;
      artifacts: string[];
      id: string;
    };

export type Decision = "accept" | "reject";

export type FreeTextAnswerPayload = { kind: "free_text"; text: string };

export type ConfirmAnswerPayload = {
  kind: "confirm";
  decision: Decision;
  text?: string;
};

export type FreeTextOrConfirmPayload =
  | FreeTextAnswerPayload
  | ConfirmAnswerPayload;

export type AskOperatorAnswer =
  | { promptId: string; kind: "free_text"; text: string }
  | {
      promptId: string;
      kind: "confirm";
      decision: Decision;
      text?: string;
    }
  | {
      promptId: string;
      kind: "artifact_backed";
      decision: Decision;
      text?: string;
    }
  | {
      promptId: string;
      kind: "multi_question";
      answers: Record<string, FreeTextOrConfirmPayload>;
    };

const subQuestionKindSchema = Type.Union([
  Type.Literal("free_text"),
  Type.Literal("confirm"),
]);

const multiQuestionItemSchema = Type.Object({
  kind: subQuestionKindSchema,
  message: Type.String({ minLength: 1 }),
  id: Type.Optional(Type.String()),
});

export const askOperatorParamsSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("free_text"),
    message: Type.String({ minLength: 1 }),
    id: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("confirm"),
    message: Type.String({ minLength: 1 }),
    id: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("multi_question"),
    questions: Type.Array(multiQuestionItemSchema, { minItems: 1 }),
    id: Type.Optional(Type.String()),
  }),
  Type.Object({
    kind: Type.Literal("artifact_backed"),
    message: Type.String({ minLength: 1 }),
    artifacts: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    id: Type.Optional(Type.String()),
  }),
]);

const decisionSchema = Type.Union([
  Type.Literal("accept"),
  Type.Literal("reject"),
]);

const freeTextOrConfirmPayloadSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("free_text"),
    text: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal("confirm"),
    decision: decisionSchema,
    text: Type.Optional(Type.String()),
  }),
]);

export const askOperatorAnswerSchema = Type.Union([
  Type.Object({
    promptId: Type.String({ minLength: 1 }),
    kind: Type.Literal("free_text"),
    text: Type.String(),
  }),
  Type.Object({
    promptId: Type.String({ minLength: 1 }),
    kind: Type.Literal("confirm"),
    decision: decisionSchema,
    text: Type.Optional(Type.String()),
  }),
  Type.Object({
    promptId: Type.String({ minLength: 1 }),
    kind: Type.Literal("artifact_backed"),
    decision: decisionSchema,
    text: Type.Optional(Type.String()),
  }),
  Type.Object({
    promptId: Type.String({ minLength: 1 }),
    kind: Type.Literal("multi_question"),
    answers: Type.Record(Type.String(), freeTextOrConfirmPayloadSchema),
  }),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AskOperatorError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalId(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AskOperatorError(`${field} must be a string when present`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseDecision(value: unknown, field: string): Decision {
  if (value !== "accept" && value !== "reject") {
    throw new AskOperatorError(
      `${field} must be "accept" or "reject" (decision is required)`,
    );
  }
  return value;
}

function parseOptionalText(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new AskOperatorError(`${field} must be a string when present`);
  }
  return value;
}

function parseSubQuestion(
  value: unknown,
  path: string,
): MultiQuestionItemParams {
  if (!isRecord(value)) {
    throw new AskOperatorError(`${path} must be an object`);
  }
  const kind = value.kind;
  if (kind !== "free_text" && kind !== "confirm") {
    if (typeof kind === "string") {
      throw new AskOperatorError(
        `${path}: unsupported sub-question kind "${kind}" (allowed: free_text, confirm; nested multi_question and artifact_backed are not allowed)`,
      );
    }
    throw new AskOperatorError(
      `${path}: kind must be "free_text" or "confirm"`,
    );
  }
  return {
    kind,
    message: requireNonEmptyString(value.message, `${path}.message`),
    id: optionalId(value.id, `${path}.id`),
  };
}

export function parseAskOperatorParams(value: unknown): AskOperatorParams {
  if (!isRecord(value)) {
    throw new AskOperatorError("ask_operator params must be an object");
  }

  const kind = value.kind;
  if (typeof kind !== "string") {
    throw new AskOperatorError("kind is required");
  }
  if (
    kind !== "free_text" &&
    kind !== "confirm" &&
    kind !== "multi_question" &&
    kind !== "artifact_backed"
  ) {
    throw new AskOperatorError(
      `unsupported prompt kind "${kind}" (allowed: free_text, confirm, multi_question, artifact_backed)`,
    );
  }

  const id = optionalId(value.id, "id");

  if (kind === "free_text" || kind === "confirm") {
    return {
      kind,
      message: requireNonEmptyString(value.message, "message"),
      ...(id !== undefined ? { id } : {}),
    };
  }

  if (kind === "artifact_backed") {
    if (!Array.isArray(value.artifacts)) {
      throw new AskOperatorError("artifacts must be an array");
    }
    if (value.artifacts.length < 1) {
      throw new AskOperatorError("artifacts must contain at least one path");
    }
    const artifacts = value.artifacts.map((item, index) =>
      requireNonEmptyString(item, `artifacts[${index}]`),
    );
    return {
      kind,
      message: requireNonEmptyString(value.message, "message"),
      artifacts,
      ...(id !== undefined ? { id } : {}),
    };
  }

  if (!Array.isArray(value.questions)) {
    throw new AskOperatorError("questions must be an array");
  }
  if (value.questions.length < 1) {
    throw new AskOperatorError("questions must contain at least one item");
  }
  const questions = value.questions.map((item, index) =>
    parseSubQuestion(item, `questions[${index}]`),
  );
  return {
    kind,
    questions,
    ...(id !== undefined ? { id } : {}),
  };
}

function newId(): string {
  return randomUUID();
}

function resolveId(supplied: string | undefined): string {
  return supplied !== undefined && supplied.trim() !== ""
    ? supplied.trim()
    : newId();
}

export function normalizePromptIds(
  params: AskOperatorParams,
): AskOperatorPrompt {
  const id = resolveId(params.id);

  if (params.kind === "free_text" || params.kind === "confirm") {
    return {
      kind: params.kind,
      message: params.message,
      id,
    };
  }

  if (params.kind === "artifact_backed") {
    return {
      kind: "artifact_backed",
      message: params.message,
      artifacts: params.artifacts,
      id,
    };
  }

  return {
    kind: "multi_question",
    id,
    questions: params.questions.map((q) => ({
      kind: q.kind,
      message: q.message,
      id: resolveId(q.id),
    })),
  };
}

function parseFreeTextOrConfirmPayload(
  value: unknown,
  path: string,
): FreeTextOrConfirmPayload {
  if (!isRecord(value)) {
    throw new AskOperatorError(`${path} must be an object`);
  }
  const kind = value.kind;
  if (kind === "free_text") {
    if (typeof value.text !== "string") {
      throw new AskOperatorError(`${path}.text must be a string`);
    }
    return { kind: "free_text", text: value.text };
  }
  if (kind === "confirm") {
    const decision = parseDecision(value.decision, `${path}.decision`);
    const text = parseOptionalText(value.text, `${path}.text`);
    return text !== undefined
      ? { kind: "confirm", decision, text }
      : { kind: "confirm", decision };
  }
  if (typeof kind === "string") {
    throw new AskOperatorError(
      `${path}: unsupported answer kind "${kind}" (allowed: free_text, confirm)`,
    );
  }
  throw new AskOperatorError(
    `${path}: kind must be "free_text" or "confirm"`,
  );
}

export function parseAskOperatorAnswer(value: unknown): AskOperatorAnswer {
  if (!isRecord(value)) {
    throw new AskOperatorError("ask_operator answer must be an object");
  }

  const promptId = requireNonEmptyString(value.promptId, "promptId");
  const kind = value.kind;
  if (typeof kind !== "string") {
    throw new AskOperatorError("kind is required");
  }
  if (
    kind !== "free_text" &&
    kind !== "confirm" &&
    kind !== "multi_question" &&
    kind !== "artifact_backed"
  ) {
    throw new AskOperatorError(
      `unsupported answer kind "${kind}" (allowed: free_text, confirm, multi_question, artifact_backed)`,
    );
  }

  if (kind === "free_text") {
    if (typeof value.text !== "string") {
      throw new AskOperatorError("text must be a string");
    }
    return { promptId, kind: "free_text", text: value.text };
  }

  if (kind === "confirm" || kind === "artifact_backed") {
    const decision = parseDecision(value.decision, "decision");
    const text = parseOptionalText(value.text, "text");
    return text !== undefined
      ? { promptId, kind, decision, text }
      : { promptId, kind, decision };
  }

  if (!isRecord(value.answers)) {
    throw new AskOperatorError("answers must be an object");
  }
  const answers: Record<string, FreeTextOrConfirmPayload> = {};
  for (const [subId, payload] of Object.entries(value.answers)) {
    answers[subId] = parseFreeTextOrConfirmPayload(
      payload,
      `answers[${subId}]`,
    );
  }
  return { promptId, kind: "multi_question", answers };
}

function assertSubAnswerMatches(
  question: MultiQuestionItem,
  payload: FreeTextOrConfirmPayload | undefined,
): void {
  if (payload === undefined) {
    throw new AskOperatorError(
      `multi_question answer missing response for sub-question id "${question.id}"`,
    );
  }
  if (payload.kind !== question.kind) {
    throw new AskOperatorError(
      `answer kind "${payload.kind}" does not match sub-question kind "${question.kind}" for id "${question.id}"`,
    );
  }
  if (payload.kind === "free_text") {
    if (typeof payload.text !== "string") {
      throw new AskOperatorError(
        `free_text answer for sub-question id "${question.id}" requires text`,
      );
    }
    return;
  }
  if (payload.decision !== "accept" && payload.decision !== "reject") {
    throw new AskOperatorError(
      `confirm answer for sub-question id "${question.id}" requires decision`,
    );
  }
}

export function assertAnswerMatchesPrompt(
  prompt: AskOperatorPrompt,
  answer: AskOperatorAnswer,
): void {
  if (answer.promptId !== prompt.id) {
    throw new AskOperatorError(
      `answer promptId "${answer.promptId}" does not match prompt id "${prompt.id}"`,
    );
  }
  if (answer.kind !== prompt.kind) {
    throw new AskOperatorError(
      `answer kind "${answer.kind}" does not match prompt kind "${prompt.kind}"`,
    );
  }

  if (prompt.kind === "free_text" && answer.kind === "free_text") {
    if (typeof answer.text !== "string") {
      throw new AskOperatorError("free_text answer requires text");
    }
    return;
  }

  if (
    (prompt.kind === "confirm" && answer.kind === "confirm") ||
    (prompt.kind === "artifact_backed" && answer.kind === "artifact_backed")
  ) {
    if (answer.decision !== "accept" && answer.decision !== "reject") {
      throw new AskOperatorError(
        `${prompt.kind} answer requires decision ("accept" or "reject")`,
      );
    }
    return;
  }

  if (prompt.kind === "multi_question" && answer.kind === "multi_question") {
    const expectedIds = new Set(prompt.questions.map((q) => q.id));
    const actualIds = Object.keys(answer.answers);
    for (const question of prompt.questions) {
      assertSubAnswerMatches(question, answer.answers[question.id]);
    }
    for (const subId of actualIds) {
      if (!expectedIds.has(subId)) {
        throw new AskOperatorError(
          `multi_question answer includes unknown sub-question id "${subId}"`,
        );
      }
    }
    if (actualIds.length !== expectedIds.size) {
      throw new AskOperatorError(
        `multi_question answer must cover every sub-question id (expected ${expectedIds.size}, got ${actualIds.length})`,
      );
    }
    return;
  }

  throw new AskOperatorError("answer does not match prompt");
}

export const parsePrompt = parseAskOperatorParams;
export const parseAnswer = parseAskOperatorAnswer;

export type AskOperatorWaitBridge = {
  requestWait: (prompt: AskOperatorPrompt) => Promise<unknown>;
};

export type AskOperatorToolOptions = AskOperatorWaitBridge;

export type AskOperatorToolDetails = {
  prompt: AskOperatorPrompt | null;
  answer: AskOperatorAnswer | null;
  error: string;
};

function toolResult(
  text: string,
  details: AskOperatorToolDetails,
  options?: { isError?: boolean },
) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    ...(options?.isError ? { isError: true as const } : {}),
  };
}

function summarizeAnswer(answer: AskOperatorAnswer): string {
  if (answer.kind === "free_text") {
    return `Operator answered: ${answer.text}`;
  }
  if (answer.kind === "confirm" || answer.kind === "artifact_backed") {
    return answer.text !== undefined && answer.text !== ""
      ? `Operator ${answer.decision}: ${answer.text}`
      : `Operator ${answer.decision}`;
  }
  const count = Object.keys(answer.answers).length;
  return `Operator answered ${count} question${count === 1 ? "" : "s"}`;
}

export function createAskOperatorTool(options: AskOperatorToolOptions) {
  const { requestWait } = options;

  return {
    name: "ask_operator",
    label: "Ask operator",
    description:
      "Ask the operator a question and wait for their answer. Supports free_text, confirm, multi_question, and artifact_backed prompts. Does not complete the stage — call emit_stage_envelope when finished.",
    parameters: askOperatorParamsSchema,
    execute: async (_toolCallId: string, params: unknown) => {
      let prompt: AskOperatorPrompt;
      try {
        const parsed = parseAskOperatorParams(params);
        prompt = normalizePromptIds(parsed);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolResult(`Invalid ask_operator params: ${message}`, {
          prompt: null,
          answer: null,
          error: message,
        }, { isError: true });
      }

      const rawAnswer = await requestWait(prompt);

      let answer: AskOperatorAnswer;
      try {
        answer = parseAskOperatorAnswer(rawAnswer);
        assertAnswerMatchesPrompt(prompt, answer);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return toolResult(`Invalid operator answer: ${message}`, {
          prompt,
          answer: null,
          error: message,
        }, { isError: true });
      }

      return toolResult(summarizeAnswer(answer), {
        prompt,
        answer,
        error: "",
      });
    },
  };
}

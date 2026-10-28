/**
 * Custom Pi tool the stage agent must call once when finished.
 *
 * Parameter schemas use `typebox` (Pi's `defineTool` TSchema), not
 * `@sinclair/typebox`. An accepted emit returns `terminate: true` so Pi
 * ends the turn instead of asking the model to continue.
 *
 * Do not abort the session from inside `execute`: providers that bridge tools
 * (e.g. MCP) may still be waiting for this result, and abort-while-running
 * deadlocks waitForIdle so later pipeline stages never start.
 */
import { EMIT_STAGE_ENVELOPE_TOOL_NAME } from "./stageToolNames.js";
import { Type } from "typebox";
import type { TSchema } from "typebox/type";
import {
  assertRequiredEnvelope,
  isAdvancingEnvelope,
} from "../envelope/check.js";
import { assertFeedbackLoopAction } from "../envelope/feedbackLoop.js";
import { normalizeForkChoice } from "../envelope/forkChoice.js";
import {
  assertEnvelopePayload,
  compilePayloadSchema,
} from "../envelope/payloadSchema.js";
import { assertEmittedArtifactsOnDisk } from "../envelope/assertEmittedArtifacts.js";
import {
  assertPreEmitChecks,
  type PreEmitCheckOptions,
} from "../envelope/preEmitChecks.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { FeedbackLoopConfig } from "../types/pipeline.js";
import type { CloneEmitContext, ForkEmitContext } from "../types/forkChoice.js";
import { prepareEmitStageEnvelopeArguments } from "./prepareToolArguments.js";

export type EmitCapture = {
  envelope?: StageEnvelope;
  error?: string;
};

function stringLiteralsSchema(values: readonly string[]) {
  if (values.length === 1) {
    return Type.Literal(values[0]!);
  }
  return Type.Union(
    values.map((value) => Type.Literal(value)) as [
      ReturnType<typeof Type.Literal>,
      ReturnType<typeof Type.Literal>,
      ...ReturnType<typeof Type.Literal>[],
    ],
  );
}

function feedbackLoopActionSchema(context: FeedbackLoopConfig): TSchema {
  return Type.Union([
    Type.Object(
      { action: Type.Literal("continue") },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        action: Type.Literal("send_back"),
        target: stringLiteralsSchema([context.target]),
      },
      { additionalProperties: false },
    ),
  ]);
}

const closed = { additionalProperties: false } as const;

function checklistAttestationsSchema() {
  return Type.Optional(
    Type.Array(
      Type.Object(
        {
          check_id: Type.String({ minLength: 1 }),
          items: Type.Array(Type.String()),
        },
        closed,
      ),
    ),
  );
}

function emitStageEnvelopeParameters(input: {
  compiledPayload?: TSchema;
  forkEmitContext?: ForkEmitContext;
  feedbackLoopEmitContext?: FeedbackLoopConfig;
}) {
  const freePayload = Type.Record(Type.String(), Type.Unknown());
  const payloadValue = input.compiledPayload ?? freePayload;
  const forkOptional = Type.Optional(Type.Array(Type.String()));
  const forkOnSuccess =
    input.forkEmitContext !== undefined && input.feedbackLoopEmitContext === undefined
      ? Type.Array(Type.String())
      : forkOptional;
  const shared = {
    summary: Type.String({ minLength: 1 }),
    artifacts: Type.Array(Type.String()),
    checklist_attestations: checklistAttestationsSchema(),
    stage_id: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
  };
  const success = Type.Object(
    {
      status: Type.Literal("success"),
      ...shared,
      payload:
        input.compiledPayload !== undefined ? input.compiledPayload : Type.Optional(freePayload),
      fork_choice: forkOnSuccess,
      ...(input.feedbackLoopEmitContext !== undefined
        ? { feedback_loop: feedbackLoopActionSchema(input.feedbackLoopEmitContext) }
        : {}),
    },
    closed,
  );
  const failure = Type.Object(
    {
      status: Type.Literal("failure"),
      ...shared,
      payload: Type.Optional(payloadValue),
      fork_choice: forkOptional,
    },
    closed,
  );
  return Type.Union([success, failure]);
}

function toolResult(
  text: string,
  details: { advancing: boolean; error: string },
  options?: { isError?: boolean; terminate?: boolean },
) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    ...(options?.isError ? { isError: true } : {}),
    ...(options?.terminate ? { terminate: true } : {}),
  };
}

export function createEmitStageEnvelopeTool(
  capture: EmitCapture,
  payloadSchema?: unknown,
  forkEmitContext?: ForkEmitContext,
  _cloneEmitContext?: CloneEmitContext,
  preEmitCheckOptions?: PreEmitCheckOptions,
  feedbackLoopEmitContext?: FeedbackLoopConfig,
) {
  const compiledPayload =
    payloadSchema !== undefined
      ? compilePayloadSchema(payloadSchema)
      : undefined;

  return {
    name: EMIT_STAGE_ENVELOPE_TOOL_NAME,
    label: "Emit stage envelope",
    description:
      "Emit the shared stage handoff envelope. Call exactly once when the stage is complete. The pipeline cannot advance until this tool succeeds.",
    parameters: emitStageEnvelopeParameters({
      compiledPayload,
      forkEmitContext,
      feedbackLoopEmitContext,
    }),
    prepareArguments: prepareEmitStageEnvelopeArguments as (
      args: unknown,
    ) => never,
    execute: async (_toolCallId: string, params: unknown) => {
      if (capture.envelope) {
        return toolResult(
          "Envelope already accepted; later emits are ignored.",
          { advancing: isAdvancingEnvelope(capture.envelope), error: "" },
          { terminate: true },
        );
      }
      try {
        const envelope = assertRequiredEnvelope(
          prepareEmitStageEnvelopeArguments(params),
        );
        assertFeedbackLoopAction(envelope, feedbackLoopEmitContext);
        const isSendBack = envelope.feedback_loop?.action === "send_back";
        if (
          envelope.status !== "failure" &&
          !isSendBack &&
          forkEmitContext !== undefined
        ) {
          normalizeForkChoice(
            envelope.fork_choice,
            "emit",
            forkEmitContext,
          );
        }
        assertEnvelopePayload(envelope, payloadSchema);
        if (envelope.status !== "failure") {
          await assertPreEmitChecks(envelope, preEmitCheckOptions);
          await assertEmittedArtifactsOnDisk(
            envelope.artifacts,
            preEmitCheckOptions?.artifactPresence,
          );
        }
        capture.envelope = envelope;
        const advancing = isAdvancingEnvelope(envelope);
        return toolResult(
          advancing
            ? "Envelope accepted; stage may advance."
            : "Envelope accepted with status=failure; pipeline will stop.",
          { advancing, error: "" },
          { terminate: true },
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        capture.error = message;
        return toolResult(
          `Invalid envelope: ${message}`,
          { advancing: false, error: message },
          { isError: true },
        );
      }
    },
  };
}

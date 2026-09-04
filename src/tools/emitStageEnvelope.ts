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
import { Type } from "typebox";
import type { TSchema } from "typebox/type";
import {
  assertRequiredEnvelope,
  isAdvancingEnvelope,
} from "../envelope/check.js";
import { assertCloneForks } from "../envelope/cloneForks.js";
import { normalizeForkChoice } from "../envelope/forkChoice.js";
import {
  assertEnvelopePayload,
  compilePayloadSchema,
} from "../envelope/payloadSchema.js";
import {
  assertPreEmitChecks,
  type PreEmitCheckOptions,
} from "../envelope/preEmitChecks.js";
import type { StageEnvelope } from "../types/envelope.js";
import {
  CLONE_ACTIONS,
  type CloneAction,
  type CloneEmitContext,
  type ForkEmitContext,
} from "../types/forkChoice.js";

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

function stageEnvelopeSchema(payloadSchema?: TSchema) {
  return Type.Object({
    status: Type.Union([Type.Literal("success"), Type.Literal("failure")]),
    summary: Type.String({ minLength: 1 }),
    artifacts: Type.Array(Type.String()),
    payload: Type.Optional(
      payloadSchema !== undefined
        ? payloadSchema
        : Type.Record(Type.String(), Type.Unknown()),
    ),
  });
}

function cloneForksItemSchema(cloneEmitContext: CloneEmitContext): TSchema {
  const allowedActions: CloneAction[] =
    cloneEmitContext.allowedActions ?? [...CLONE_ACTIONS];
  const allowSkip = allowedActions.includes("skip");
  const allowOnce = allowedActions.includes("once");
  const allowFanout = allowedActions.includes("fanout");
  const variants: TSchema[] = [];

  for (const successor of cloneEmitContext.clonableSuccessors) {
    const successorId = Type.Literal(successor.successorId);
    const nestedPayload =
      successor.cloneInputSchema !== undefined
        ? compilePayloadSchema(successor.cloneInputSchema)
        : undefined;
    const nestedEnvelope = stageEnvelopeSchema(nestedPayload);

    if (allowSkip) {
      variants.push(
        Type.Object(
          {
            successor_id: successorId,
            action: Type.Literal("skip"),
          },
          { additionalProperties: false },
        ),
      );
    }
    if (allowOnce) {
      variants.push(
        Type.Object({
          successor_id: successorId,
          action: Type.Literal("once"),
          envelope: nestedEnvelope,
        }),
      );
    }
    if (allowFanout) {
      variants.push(
        Type.Object({
          successor_id: successorId,
          action: Type.Literal("fanout"),
          mode: Type.Union([
            Type.Literal("parallel"),
            Type.Literal("sequential"),
          ]),
          clones: Type.Array(
            Type.Object({
              envelope: nestedEnvelope,
            }),
            { minItems: 2, maxItems: successor.cloneCap },
          ),
        }),
      );
    }
  }

  if (variants.length === 0) {
    return Type.Object({
      successor_id: Type.String(),
      action: stringLiteralsSchema(allowedActions),
    });
  }
  if (variants.length === 1) {
    return variants[0]!;
  }
  return Type.Union(
    variants as [TSchema, TSchema, ...TSchema[]],
  );
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
  cloneEmitContext?: CloneEmitContext,
  preEmitCheckOptions?: PreEmitCheckOptions,
) {
  const compiledPayload =
    payloadSchema !== undefined
      ? compilePayloadSchema(payloadSchema)
      : undefined;

  return {
    name: "emit_stage_envelope",
    label: "Emit stage envelope",
    description:
      "Emit the shared stage handoff envelope. Call exactly once when the stage is complete. The pipeline cannot advance until this tool succeeds.",
    parameters: Type.Object({
      status: Type.Union([Type.Literal("success"), Type.Literal("failure")]),
      summary: Type.String({ minLength: 1 }),
      artifacts: Type.Array(Type.String()),
      payload: Type.Optional(
        compiledPayload !== undefined
          ? compiledPayload
          : Type.Record(Type.String(), Type.Unknown()),
      ),
      fork_choice:
        forkEmitContext !== undefined
          ? Type.Array(Type.String())
          : Type.Optional(Type.Array(Type.String())),
      ...(cloneEmitContext !== undefined
        ? {
            clone_forks: Type.Array(cloneForksItemSchema(cloneEmitContext)),
          }
        : {}),
      checklist_attestations: Type.Optional(
        Type.Array(
          Type.Object({
            check_id: Type.String({ minLength: 1 }),
            items: Type.Array(Type.String()),
          }),
        ),
      ),
      stage_id: Type.Optional(Type.String()),
      notes: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId: string, params: unknown) => {
      if (capture.envelope) {
        return toolResult(
          "Envelope already accepted; later emits are ignored.",
          { advancing: isAdvancingEnvelope(capture.envelope), error: "" },
          { terminate: true },
        );
      }
      try {
        const record = params as Record<string, unknown>;
        if (record.status !== "failure" && forkEmitContext !== undefined) {
          normalizeForkChoice(
            record.fork_choice as string[] | undefined,
            "emit",
            forkEmitContext,
          );
        }
        if (record.status !== "failure" && cloneEmitContext !== undefined) {
          assertCloneForks(params, cloneEmitContext);
        }
        const envelope = assertRequiredEnvelope(params);
        assertEnvelopePayload(envelope, payloadSchema);
        if (envelope.status !== "failure") {
          await assertPreEmitChecks(envelope, preEmitCheckOptions);
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

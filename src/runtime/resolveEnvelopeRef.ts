import { mapStoreLookupError, type StoreLookupKind } from "../server/operatorResults.js";
import type { RunStore } from "../runstore/port.js";
import type { StageEnvelope } from "../types/envelope.js";
import type { TaskFile } from "../types/task.js";

export type EnvelopeRefInput = {
  runId: string;
  stageId: string;
  attempt?: number;
};

type EnvelopeRefStore = Pick<RunStore, "readRunMeta" | "readRun" | "readEnvelope">;

/** Carries enough to map onto either MCP's textResult shape or an A2aApplicationError. */
export class EnvelopeRefError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly kind: StoreLookupKind,
  ) {
    super(message);
  }
}

async function resolveOne(
  store: EnvelopeRefStore,
  ref: EnvelopeRefInput,
): Promise<StageEnvelope> {
  try {
    await store.readRunMeta(ref.runId);
  } catch (err) {
    const mapped = mapStoreLookupError(err, { policy: "run" });
    throw new EnvelopeRefError(mapped.error, mapped.status, mapped.kind);
  }
  try {
    const detail = await store.readRun(ref.runId);
    if (!detail.stages.some((s) => s.stage_id === ref.stageId)) {
      throw new EnvelopeRefError(`Stage not found: ${ref.stageId}`, 404, "not_found");
    }
    return await store.readEnvelope(ref.runId, ref.stageId, ref.attempt);
  } catch (err) {
    if (err instanceof EnvelopeRefError) throw err;
    const mapped = mapStoreLookupError(err, { policy: "envelope" });
    throw new EnvelopeRefError(mapped.error, mapped.status, mapped.kind);
  }
}

/**
 * Resolves one or more Envelope References (ADR-0002) into a TaskFile for
 * the next standalone stage call — shared by the MCP run_stage tool and the
 * A2A run_stage operation so this resolution logic exists in exactly one
 * place (it was duplicated between them once already; see the reuse finding
 * from this feature's code review).
 *
 * A single ref keeps today's exact shape: goal = its summary, input = its
 * payload verbatim. Multiple refs namespace each resolved payload under its
 * stageId (disambiguated by runId only if two refs share a stageId), so a
 * stage author addresses each source by name in their own io.input.schema
 * instead of one silently overwriting another on a key collision.
 */
export async function resolveEnvelopeRefsToTask(
  store: EnvelopeRefStore,
  refs: EnvelopeRefInput | EnvelopeRefInput[],
  checkout?: string,
): Promise<TaskFile> {
  const list = Array.isArray(refs) ? refs : [refs];
  const resolved: Array<{ ref: EnvelopeRefInput; envelope: StageEnvelope }> = [];
  for (const ref of list) {
    resolved.push({ ref, envelope: await resolveOne(store, ref) });
  }

  if (resolved.length === 1) {
    const { ref, envelope } = resolved[0];
    return {
      id: `ref-${ref.runId}-${ref.stageId}`,
      goal: envelope.summary,
      input: envelope.payload ?? {},
      ...(checkout ? { checkout } : {}),
    };
  }

  const usedKeys = new Set<string>();
  const input: Record<string, unknown> = {};
  const summaryLines: string[] = [];
  for (const { ref, envelope } of resolved) {
    let key = ref.stageId;
    if (usedKeys.has(key)) key = `${ref.stageId}:${ref.runId}`;
    usedKeys.add(key);
    input[key] = envelope.payload ?? {};
    summaryLines.push(`${key}: ${envelope.summary}`);
  }

  return {
    id: `ref-${list.map((r) => r.stageId).join("+")}`,
    goal: summaryLines.join("\n"),
    input,
    ...(checkout ? { checkout } : {}),
  };
}

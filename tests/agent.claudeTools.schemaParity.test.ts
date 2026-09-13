import { describe, expect, it } from "vitest";
import {
  buildEmitStageEnvelopeShape,
  writeStageArtifactShape,
} from "../src/agent/claudeTools.js";
import { createEmitStageEnvelopeTool } from "../src/tools/emitStageEnvelope.js";
import { createWriteStageArtifactTool } from "../src/tools/writeStageArtifact.js";
import type { CloneEmitContext, ForkEmitContext } from "../src/types/forkChoice.js";

/**
 * `claudeTools.ts`'s Zod shapes and `tools/emitStageEnvelope.ts` /
 * `writeStageArtifact.ts`'s typebox schemas are hand-written against the
 * same envelope/artifact shape with no shared source — nothing else
 * catches one drifting from the other. These tests make the field list
 * itself the thing under test, at both the "no fork/clone" and
 * "fork + clone" shapes, since the typebox schema's own field set is
 * conditional on those contexts.
 */
function typeboxFieldNames(
  forkEmitContext?: ForkEmitContext,
  cloneEmitContext?: CloneEmitContext,
): string[] {
  const def = createEmitStageEnvelopeTool({}, undefined, forkEmitContext, cloneEmitContext);
  return Object.keys((def.parameters as { properties: Record<string, unknown> }).properties);
}

function zodFieldNames(
  forkEmitContext?: ForkEmitContext,
  cloneEmitContext?: CloneEmitContext,
): string[] {
  return Object.keys(buildEmitStageEnvelopeShape({ forkEmitContext, cloneEmitContext }));
}

const CLONE_CONTEXT: CloneEmitContext = {
  clonableSuccessors: [{ successorId: "review", cloneCap: 3 }],
};

const FORK_CONTEXT: ForkEmitContext = {
  immediateSuccessorIds: ["a", "b"],
  forkShape: { cardinality: "one", allowNone: false },
};

describe("emit_stage_envelope schema parity — typebox (Pi) vs Zod (Claude)", () => {
  it("same field names with no fork/clone context", () => {
    expect(new Set(zodFieldNames())).toEqual(new Set(typeboxFieldNames()));
  });

  it("clone_forks is never on the emit schema, even when a cloneEmitContext is passed", () => {
    expect(typeboxFieldNames(undefined, CLONE_CONTEXT)).not.toContain("clone_forks");
    expect(zodFieldNames(undefined, CLONE_CONTEXT)).not.toContain("clone_forks");
    expect(typeboxFieldNames()).not.toContain("clone_forks");
    expect(zodFieldNames()).not.toContain("clone_forks");
  });

  it("same field names with both a fork and a clone context", () => {
    expect(new Set(zodFieldNames(FORK_CONTEXT, CLONE_CONTEXT))).toEqual(
      new Set(typeboxFieldNames(FORK_CONTEXT, CLONE_CONTEXT)),
    );
  });
});

describe("write_stage_artifact schema parity — typebox (Pi) vs Zod (Claude)", () => {
  it("same field names", () => {
    const typeboxDef = createWriteStageArtifactTool({
      runWorkspaceDir: "/tmp",
      stageId: "s",
      attempt: 1,
    });
    const typeboxFields = Object.keys(
      (typeboxDef.parameters as { properties: Record<string, unknown> }).properties,
    );
    expect(new Set(Object.keys(writeStageArtifactShape))).toEqual(new Set(typeboxFields));
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";
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
type Branch = { properties?: Record<string, unknown>; required?: string[] };

function branchesOf(schema: { anyOf?: Branch[]; oneOf?: Branch[] }): Branch[] {
  return schema.anyOf ?? schema.oneOf ?? [];
}

/** The Pi tool is one flat object (OpenAI needs `type: "object"` at the root); Claude keeps a union per status. */
function fieldNames(
  forkEmitContext?: ForkEmitContext,
  cloneEmitContext?: CloneEmitContext,
): { typebox: string[]; zod: string[]; typeboxRequired: string[]; zodRequired: string[][] } {
  const def = createEmitStageEnvelopeTool({}, undefined, forkEmitContext, cloneEmitContext);
  const root = def.parameters as { type?: string; properties?: Record<string, unknown>; required?: string[] };
  expect(root.type).toBe("object");
  const zodJson = z.toJSONSchema(buildEmitStageEnvelopeShape({ forkEmitContext, cloneEmitContext })) as {
    anyOf?: Branch[];
    oneOf?: Branch[];
  };
  const branches = branchesOf(zodJson);
  return {
    typebox: Object.keys(root.properties ?? {}).sort(),
    zod: [...new Set(branches.flatMap((branch) => Object.keys(branch.properties ?? {})))].sort(),
    typeboxRequired: [...(root.required ?? [])].sort(),
    zodRequired: branches.map((branch) => [...(branch.required ?? [])].sort()),
  };
}

function expectParity(forkEmitContext?: ForkEmitContext, cloneEmitContext?: CloneEmitContext): void {
  const fields = fieldNames(forkEmitContext, cloneEmitContext);
  expect(fields.zod).toEqual(fields.typebox);
  // Whatever the flat schema requires, every Claude branch requires too.
  for (const required of fields.zodRequired) {
    for (const name of fields.typeboxRequired) expect(required).toContain(name);
  }
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
    expectParity();
  });

  it("clone_forks is never on the emit schema, even when a cloneEmitContext is passed", () => {
    expect(fieldNames(undefined, CLONE_CONTEXT).typebox).not.toContain("clone_forks");
    expect(fieldNames(undefined, CLONE_CONTEXT).zod).not.toContain("clone_forks");
    expect(fieldNames().typebox).not.toContain("clone_forks");
    expect(fieldNames().zod).not.toContain("clone_forks");
  });

  it("same field names with both a fork and a clone context", () => {
    expectParity(FORK_CONTEXT, CLONE_CONTEXT);
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

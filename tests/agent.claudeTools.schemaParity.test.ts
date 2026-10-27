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

function statusOf(branch: Branch): string {
  const status = branch.properties?.status as { const?: string } | undefined;
  return status?.const ?? "";
}

function branchFields(
  forkEmitContext?: ForkEmitContext,
  cloneEmitContext?: CloneEmitContext,
): { typebox: Map<string, { fields: string[]; required: string[] }>; zod: Map<string, { fields: string[]; required: string[] }> } {
  const def = createEmitStageEnvelopeTool({}, undefined, forkEmitContext, cloneEmitContext);
  const zodJson = z.toJSONSchema(buildEmitStageEnvelopeShape({ forkEmitContext, cloneEmitContext })) as {
    anyOf?: Branch[];
    oneOf?: Branch[];
  };
  const collect = (branches: Branch[]) => {
    const map = new Map<string, { fields: string[]; required: string[] }>();
    for (const branch of branches) {
      map.set(statusOf(branch), {
        fields: Object.keys(branch.properties ?? {}).sort(),
        required: [...(branch.required ?? [])].sort(),
      });
    }
    return map;
  };
  return {
    typebox: collect(branchesOf(def.parameters as { anyOf?: Branch[] })),
    zod: collect(branchesOf(zodJson)),
  };
}

function fieldNames(
  forkEmitContext?: ForkEmitContext,
  cloneEmitContext?: CloneEmitContext,
): { typebox: string[]; zod: string[] } {
  const { typebox, zod } = branchFields(forkEmitContext, cloneEmitContext);
  const names = (map: Map<string, { fields: string[] }>) =>
    [...new Set([...map.values()].flatMap((branch) => branch.fields))].sort();
  return { typebox: names(typebox), zod: names(zod) };
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
    const fields = fieldNames();
    expect(fields.zod).toEqual(fields.typebox);
    expect(branchFields().zod).toEqual(branchFields().typebox);
  });

  it("clone_forks is never on the emit schema, even when a cloneEmitContext is passed", () => {
    expect(fieldNames(undefined, CLONE_CONTEXT).typebox).not.toContain("clone_forks");
    expect(fieldNames(undefined, CLONE_CONTEXT).zod).not.toContain("clone_forks");
    expect(fieldNames().typebox).not.toContain("clone_forks");
    expect(fieldNames().zod).not.toContain("clone_forks");
  });

  it("same field names with both a fork and a clone context", () => {
    const fields = fieldNames(FORK_CONTEXT, CLONE_CONTEXT);
    expect(fields.zod).toEqual(fields.typebox);
    expect(branchFields(FORK_CONTEXT, CLONE_CONTEXT).zod).toEqual(
      branchFields(FORK_CONTEXT, CLONE_CONTEXT).typebox,
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

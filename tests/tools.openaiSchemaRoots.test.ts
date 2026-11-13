import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAskOperatorTool } from "../src/tools/askOperator.js";
import { createEmitStageEnvelopeTool } from "../src/tools/emitStageEnvelope.js";
import { createWorkingStateTool } from "../src/tools/workingState.js";
import { createWriteStageArtifactTool } from "../src/tools/writeStageArtifact.js";
import { createGuideKnowledgeTools } from "../src/guide/knowledgeTools.js";
import type { FeedbackLoopConfig } from "../src/types/pipeline.js";
import type { ForkEmitContext } from "../src/types/forkChoice.js";
import { REPO_ROOT } from "./helpers/fixturePaths.js";

/**
 * OpenAI rejects a tool whose parameters are not a JSON Schema object at the root
 * ("Invalid schema for function ...: schema must be a JSON Schema of type object, got type None").
 * This mirrors that check so a union, intersection or bare type at the root never ships again.
 */
function assertOpenAiToolRoot(name: string, schema: unknown): void {
  const root = schema as Record<string, unknown>;
  expect(root, name).toBeTypeOf("object");
  expect(root.type, `${name}: root type`).toBe("object");
  for (const key of ["anyOf", "oneOf", "allOf", "not", "enum"]) {
    expect(root[key], `${name}: root ${key}`).toBeUndefined();
  }
  expect(root.properties, `${name}: root properties`).toBeTypeOf("object");
}

const FORK: ForkEmitContext = {
  immediateSuccessorIds: ["a", "b"],
  forkShape: { cardinality: "one", allowNone: false },
};
const LOOP = { target: "draft" } as unknown as FeedbackLoopConfig;

describe("tool parameter roots are OpenAI-compatible objects", () => {
  it("emit_stage_envelope in every context", () => {
    const payload = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
    for (const [label, tool] of [
      ["plain", createEmitStageEnvelopeTool({})],
      ["payload", createEmitStageEnvelopeTool({}, payload)],
      ["empty payload", createEmitStageEnvelopeTool({}, { type: "object" })],
      ["fork", createEmitStageEnvelopeTool({}, undefined, FORK)],
      ["feedback loop", createEmitStageEnvelopeTool({}, undefined, undefined, undefined, undefined, LOOP)],
    ] as const) {
      assertOpenAiToolRoot(`emit_stage_envelope (${label})`, tool.parameters);
    }
  });

  it("ask_operator for every set of allowed kinds", () => {
    const requestWait = async () => ({});
    for (const allowedKinds of [undefined, ["free_text"], ["confirm", "multi_question"], ["artifact_backed"]] as const) {
      const tool = createAskOperatorTool({ requestWait, allowedKinds } as never);
      assertOpenAiToolRoot(`ask_operator (${allowedKinds?.join(",") ?? "all"})`, tool.parameters);
    }
  });

  it("working_state, write_stage_artifact and the guide tools", () => {
    const working = createWorkingStateTool({ store: {} as never, persist: () => {} });
    assertOpenAiToolRoot("working_state", working.parameters);
    const artifact = createWriteStageArtifactTool({ runWorkspaceDir: "/tmp", stageId: "s", attempt: 1 });
    assertOpenAiToolRoot("write_stage_artifact", artifact.parameters);
    for (const tool of createGuideKnowledgeTools()) assertOpenAiToolRoot(tool.name, tool.parameters);
  });

  it("no tool in src declares a union or intersection as its parameters", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".ts")) {
          readFileSync(full, "utf8").split("\n").forEach((line, index) => {
            if (/parameters:\s*(Type\.(Union|Intersect)|z\.(union|discriminatedUnion|intersection))\(/.test(line)) {
              offenders.push(`${path.relative(REPO_ROOT, full)}:${index + 1}`);
            }
          });
        }
      }
    };
    walk(path.join(REPO_ROOT, "src"));
    expect(offenders).toEqual([]);
  });
});

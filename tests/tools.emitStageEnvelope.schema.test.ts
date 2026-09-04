import { describe, expect, it } from "vitest";
import { createEmitStageEnvelopeTool } from "../src/tools/emitStageEnvelope.js";
import type { CloneEmitContext } from "../src/types/forkChoice.js";

type JsonSchema = {
  type?: string;
  const?: unknown;
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
};

function cloneForkItems(
  tool: ReturnType<typeof createEmitStageEnvelopeTool>,
): JsonSchema[] {
  const params = tool.parameters as {
    properties?: { clone_forks?: { items?: JsonSchema } };
  };
  const items = params.properties?.clone_forks?.items;
  if (items === undefined) return [];
  if (Array.isArray(items.anyOf)) return items.anyOf;
  return [items];
}

function actionConst(variant: JsonSchema): string | undefined {
  const action = variant.properties?.action;
  return typeof action?.const === "string" ? action.const : undefined;
}

function findVariant(
  tool: ReturnType<typeof createEmitStageEnvelopeTool>,
  action: string,
): JsonSchema | undefined {
  return cloneForkItems(tool).find((variant) => actionConst(variant) === action);
}

describe("emit_stage_envelope clone_forks schema foresight (U2)", () => {
  it("once successor → envelope object has status, summary, artifacts (not Unknown)", () => {
    const tool = createEmitStageEnvelopeTool(
      {},
      undefined,
      undefined,
      {
        clonableSuccessors: [{ successorId: "analyze", cloneCap: 3 }],
      },
    );
    const once = findVariant(tool, "once");
    expect(once).toBeDefined();
    const envelope = once!.properties?.envelope;
    expect(envelope?.type).toBe("object");
    expect(envelope?.properties?.status).toBeDefined();
    expect(envelope?.properties?.summary).toBeDefined();
    expect(envelope?.properties?.artifacts).toBeDefined();
    expect(envelope?.required).toEqual(
      expect.arrayContaining(["status", "summary", "artifacts"]),
    );
    expect(JSON.stringify(envelope)).not.toMatch(/"type"\s*:\s*"unknown"/i);
  });

  it("once with clone_input_schema requiring branch → payload.branch required", () => {
    const ctx: CloneEmitContext = {
      clonableSuccessors: [
        {
          successorId: "investigate",
          cloneCap: 4,
          cloneInputSchema: {
            type: "object",
            properties: { branch: { type: "string" } },
            required: ["branch"],
          },
        },
      ],
    };
    const tool = createEmitStageEnvelopeTool({}, undefined, undefined, ctx);
    const once = findVariant(tool, "once");
    const envelope = once?.properties?.envelope;
    const payload = envelope?.properties?.payload;
    expect(payload?.type).toBe("object");
    expect(payload?.properties?.branch).toBeDefined();
    expect(payload?.required).toContain("branch");
    expect(envelope?.required ?? []).not.toContain("payload");
  });

  it("skip variant forbids extra keys via additionalProperties false", () => {
    const tool = createEmitStageEnvelopeTool(
      {},
      undefined,
      undefined,
      {
        clonableSuccessors: [{ successorId: "analyze", cloneCap: 3 }],
      },
    );
    const skip = findVariant(tool, "skip") as JsonSchema & {
      additionalProperties?: boolean;
    };
    expect(skip).toBeDefined();
    expect(skip.additionalProperties).toBe(false);
    expect(skip.properties?.envelope).toBeUndefined();
    expect(skip.properties?.mode).toBeUndefined();
    expect(skip.properties?.clones).toBeUndefined();
  });

  it("fanout clones array has minItems 2 and maxItems cloneCap", () => {
    const tool = createEmitStageEnvelopeTool(
      {},
      undefined,
      undefined,
      {
        clonableSuccessors: [{ successorId: "analyze", cloneCap: 5 }],
      },
    );
    const fanout = findVariant(tool, "fanout");
    const clones = fanout?.properties?.clones as JsonSchema & {
      minItems?: number;
      maxItems?: number;
    };
    expect(clones?.minItems).toBe(2);
    expect(clones?.maxItems).toBe(5);
  });

  it("fanout → clones[].envelope typed", () => {
    const tool = createEmitStageEnvelopeTool(
      {},
      undefined,
      undefined,
      {
        clonableSuccessors: [{ successorId: "analyze", cloneCap: 5 }],
      },
    );
    const fanout = findVariant(tool, "fanout");
    expect(fanout).toBeDefined();
    const cloneEnvelope = fanout!.properties?.clones?.items?.properties?.envelope;
    expect(cloneEnvelope?.type).toBe("object");
    expect(cloneEnvelope?.properties?.status).toBeDefined();
    expect(cloneEnvelope?.properties?.summary).toBeDefined();
    expect(cloneEnvelope?.properties?.artifacts).toBeDefined();
    expect(cloneEnvelope?.required).toEqual(
      expect.arrayContaining(["status", "summary", "artifacts"]),
    );
  });

  it("no cloneEmitContext → no clone_forks key; base envelope unchanged", () => {
    const tool = createEmitStageEnvelopeTool({});
    const props = (
      tool.parameters as { properties?: Record<string, JsonSchema> }
    ).properties;
    expect(props?.clone_forks).toBeUndefined();
    expect(props?.status).toBeDefined();
    expect(props?.summary).toBeDefined();
    expect(props?.artifacts).toBeDefined();
    expect((tool.parameters as { required?: string[] }).required).toEqual(
      expect.arrayContaining(["status", "summary", "artifacts"]),
    );
  });

  it('allowedActions ["skip","once"] → no fanout variant in union', () => {
    const tool = createEmitStageEnvelopeTool(
      {},
      undefined,
      undefined,
      {
        clonableSuccessors: [{ successorId: "analyze", cloneCap: 3 }],
        allowedActions: ["skip", "once"],
      },
    );
    const actions = cloneForkItems(tool)
      .map(actionConst)
      .filter((a): a is string => a !== undefined);
    expect(actions).toContain("skip");
    expect(actions).toContain("once");
    expect(actions).not.toContain("fanout");
  });
});

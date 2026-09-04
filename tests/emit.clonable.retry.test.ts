import { describe, expect, it } from "vitest";
import { createEmitStageEnvelopeTool } from "../src/tools/emitStageEnvelope.js";
import type { CloneEmitContext } from "../src/types/forkChoice.js";

function makeCloneContext(): CloneEmitContext {
  return {
    clonableSuccessors: [{ successorId: "author-diagrams", cloneCap: 5 }],
  };
}

describe("emit_stage_envelope clonable retry without ask_operator (U4)", () => {
  it("missing nested status → path-qualified isError; corrected emit terminates; no ask_operator", async () => {
    const toolCalls: string[] = [];
    const capture: { envelope?: unknown; error?: string } = {};
    const tool = createEmitStageEnvelopeTool(
      capture,
      undefined,
      undefined,
      makeCloneContext(),
    );

    toolCalls.push(tool.name);
    const bad = await tool.execute("emit-1", {
      status: "success",
      summary: "fan-out diagrams",
      artifacts: [],
      clone_forks: [
        {
          successor_id: "author-diagrams",
          action: "once",
          envelope: { summary: "clone prior", artifacts: [] },
        },
      ],
    });

    expect(bad.isError).toBe(true);
    expect(bad.terminate).toBeUndefined();
    expect(capture.envelope).toBeUndefined();
    expect(bad.content[0]?.text).toContain(
      "clone_forks[0].envelope.status",
    );
    expect(toolCalls).not.toContain("ask_operator");

    toolCalls.push(tool.name);
    const good = await tool.execute("emit-2", {
      status: "success",
      summary: "fan-out diagrams",
      artifacts: [],
      clone_forks: [
        {
          successor_id: "author-diagrams",
          action: "once",
          envelope: {
            status: "success",
            summary: "clone prior",
            artifacts: [],
          },
        },
      ],
    });

    expect(good.isError).toBeUndefined();
    expect(good.terminate).toBe(true);
    expect(capture.envelope).toBeDefined();
    expect(toolCalls).toEqual(["emit_stage_envelope", "emit_stage_envelope"]);
    expect(toolCalls).not.toContain("ask_operator");
  });
});

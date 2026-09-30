import { describe, expect, it } from "vitest";
import {
  DRAFT_MUTATION_TOOL_NAME,
  buildDraftMutationToolParts,
  buildDraftMutationTools,
} from "./draftMutationTools";

describe("draftMutationTools", () => {
  it("registers draft_mutation on tools.by_name for stock Thread", () => {
    const Stub = () => null;
    const tools = buildDraftMutationTools(Stub);
    expect(Object.keys(tools.by_name)).toEqual([DRAFT_MUTATION_TOOL_NAME]);
    expect(tools.by_name[DRAFT_MUTATION_TOOL_NAME]).toBe(Stub);
    expect(DRAFT_MUTATION_TOOL_NAME).toBe("draft_mutation");
  });

  it("synthesizes tool-call parts named draft_mutation", () => {
    const parts = buildDraftMutationToolParts([
      {
        id: "mut-1",
        summary: "Add stage intake",
        affectedStageIds: ["intake"],
      },
      {
        id: "mut-2",
        summary: "Add stage review",
        affectedStageIds: ["review"],
      },
    ]);

    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "mutation-mut-1-0",
      toolName: "draft_mutation",
      args: {
        mutationId: "mut-1",
        summary: "Add stage intake",
        affectedStageIds: ["intake"],
      },
      result: { status: "applied" },
    });
    expect(JSON.parse(parts[0]!.argsText)).toEqual(parts[0]!.args);
    expect(parts[1]!.toolCallId).toBe("mutation-mut-2-1");
    expect(parts[1]!.toolName).toBe(DRAFT_MUTATION_TOOL_NAME);
  });

  it("returns empty parts when there are no proposals", () => {
    expect(buildDraftMutationToolParts([])).toEqual([]);
  });
});

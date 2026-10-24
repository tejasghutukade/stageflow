import { describe, expect, it } from "vitest";
import { formatActivityDescription, formatActivityLabel } from "./activityCopy";

describe("formatActivityLabel", () => {
  it("labels Q&A and lifecycle events", () => {
    expect(formatActivityLabel({ event: "operator_prompt" })).toBe("Operator prompt");
    expect(formatActivityLabel({ event: "operator_answer" })).toBe("Operator answer");
    expect(formatActivityLabel({ event: "started" })).toBe("Stage started");
  });

  it("describes context compaction", () => {
    const event = {
      event: "context_compacted",
      tokensBefore: 148200,
      tokensAfter: 31000,
      summaryChars: 3100,
      costUsd: 0.004,
    };
    expect(formatActivityLabel(event)).toBe("Context compacted");
    expect(formatActivityDescription(event)).toBe("148.2k -> 31k tokens, summary 3.1k chars, $0.004");
  });
});

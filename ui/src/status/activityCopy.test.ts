import { describe, expect, it } from "vitest";
import { formatActivityLabel } from "./activityCopy";

describe("formatActivityLabel", () => {
  it("labels Q&A and lifecycle events", () => {
    expect(formatActivityLabel({ event: "operator_prompt" })).toBe("Operator prompt");
    expect(formatActivityLabel({ event: "operator_answer" })).toBe("Operator answer");
    expect(formatActivityLabel({ event: "started" })).toBe("Stage started");
  });
});

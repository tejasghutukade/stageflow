import { describe, expect, it } from "vitest";
import { checkDatasetAgainstStage } from "../src/config/datasetStageCheck.js";

const schema = {
  type: "object",
  properties: { diff: { type: "string" }, plan: { type: "string" } },
  required: ["diff", "plan"],
};

describe("checkDatasetAgainstStage", () => {
  const cases = [
    { id: "a", input: { diff: "d", plan: "p" } },
    { id: "b", input: { diff: "d" } },
    { id: "c", input: { diff: 1, plan: "p" } },
  ];

  it("marks exactly the failing cases with a message", () => {
    const res = checkDatasetAgainstStage(cases, schema);
    expect(res.map((r) => [r.caseId, r.valid])).toEqual([
      ["a", true],
      ["b", false],
      ["c", false],
    ]);
    expect(res[0]!.message).toBeUndefined();
    expect(res[1]!.message).toEqual(expect.any(String));
    expect(res[1]!.message!.length).toBeGreaterThan(0);
  });

  it("treats every case as valid when the stage has no schema", () => {
    expect(checkDatasetAgainstStage(cases, undefined).every((r) => r.valid)).toBe(true);
  });
});

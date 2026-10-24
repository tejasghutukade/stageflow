import { describe, expect, it } from "vitest";
import { evalCasePath, evalNewPath, evalsPath, parseHash } from "./routes";

describe("agent routes", () => {
  it("preselects an agent in the new eval wizard", () => {
    expect(evalNewPath({ agent: "support" })).toBe("/evals/new?agent=support");
    expect(parseHash("#/evals/new?agent=support")).toEqual({ name: "evalNew", agent: "support" });
    expect(parseHash("#/evals/new")).toEqual({ name: "evalNew" });
  });

  it("filters the list by agent", () => {
    expect(evalsPath({ agent: "support" })).toBe("/evals?agent=support");
    expect(parseHash("#/evals?agent=support")).toEqual({ name: "evals", agent: "support" });
    expect(parseHash("#/evals?stage=review")).toEqual({ name: "evals", stage: "review" });
  });

  it("opens the case drawer on the transcript", () => {
    expect(evalCasePath("support-eval", 3, "s001", { tab: "transcript" })).toBe("/evals/support-eval/runs/3/case/s001?tab=transcript");
    expect(parseHash("#/evals/support-eval/runs/3/case/s001?tab=transcript")).toEqual({
      name: "evalCase",
      evalId: "support-eval",
      runNumber: 3,
      caseId: "s001",
      drawerTab: "transcript",
    });
    expect(parseHash("#/evals/support-eval/runs/3/case/s001?repeat=1")).toEqual({ name: "evalCase", evalId: "support-eval", runNumber: 3, caseId: "s001", repeat: 1 });
  });
});

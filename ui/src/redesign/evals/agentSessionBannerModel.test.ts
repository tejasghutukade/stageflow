import { describe, expect, it } from "vitest";
import type { EvalRunListItem } from "../../api";
import { agentSessionBannerModel } from "./agentSessionBannerModel";

const base = { eval_id: "support", run_number: 4 } as EvalRunListItem;

describe("agentSessionBannerModel", () => {
  it("shows nothing for a normal session", () => {
    expect(agentSessionBannerModel([])).toBeNull();
  });
  it("links to the case transcript when the result is known", () => {
    const m = agentSessionBannerModel([{ ...base, result: { case_id: "c001", repeat_index: 1 } }]);
    expect(m?.text).toBe("This session was created by eval support, run #4");
    expect(m?.href).toBe("/evals/support/runs/4/case/c001?repeat=1&tab=transcript");
  });
  it("links to the run when only the run is known", () => {
    expect(agentSessionBannerModel([base])?.href).toBe("/evals/support/runs/4");
  });
});

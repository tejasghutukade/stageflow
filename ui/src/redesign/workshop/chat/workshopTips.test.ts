import { describe, expect, it } from "vitest";
import {
  WORKSHOP_TIPS,
  tipForProposal,
  tipTopicForProposal,
  touchedTopics,
} from "./workshopTips";

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const reviewBefore = {
  id: "review",
  system_prompt: "Review the change.",
  io: { input: { schema: { type: "object" } }, output: { schema: { type: "object" } } },
  verify: [{ id: "tests", type: "command", run: "npm test" }],
};

describe("touchedTopics", () => {
  it("attributes nested changes to their ancestor key", () => {
    const after = {
      ...reviewBefore,
      verify: [{ id: "tests", type: "command", run: "npm run test:auth" }],
    };
    expect([...touchedTopics({ before: json(reviewBefore), after: json(after) })]).toEqual([
      "verify",
    ]);
  });

  it("detects io and model edits", () => {
    const after = {
      ...reviewBefore,
      model: "anthropic/claude-sonnet-4-5",
      io: { ...reviewBefore.io, output: { schema: { type: "object", required: ["ok"] } } },
    };
    const topics = touchedTopics({ before: json(reviewBefore), after: json(after) });
    expect(topics.has("io")).toBe(true);
    expect(topics.has("model")).toBe(true);
    expect(topics.has("verify")).toBe(false);
  });

  it("works on YAML text and maps gate_kinds to ask_operator", () => {
    const before = "id: review\nsystem_prompt: hi\n";
    const after = "id: review\nsystem_prompt: hi\ngate_kinds:\n  - confirm\n";
    expect([...touchedTopics({ before, after })]).toEqual(["ask_operator"]);
  });

  it("maps route, needs, and entry to route", () => {
    const before = json({ id: "p", stages: [{ id: "a" }, { id: "b" }] });
    const after = json({
      id: "p",
      stages: [{ id: "a", entry: true, route: [{ to: "b" }] }, { id: "b" }],
    });
    expect(touchedTopics({ before, after }).has("route")).toBe(true);
  });
});

describe("tipForProposal", () => {
  it("prefers on_verify_fail over verify and io", () => {
    const pipelineBefore = json({ id: "p", stages: [{ id: "review", uses: "review.yaml" }] });
    const pipelineAfter = json({
      id: "p",
      stages: [
        {
          id: "review",
          uses: "review.yaml",
          on_verify_fail: { mode: "repair", max_attempts: 2 },
        },
      ],
    });
    const proposal = {
      artifacts: [
        { before: json(reviewBefore), after: json({ ...reviewBefore, verify: [] }) },
        { before: pipelineBefore, after: pipelineAfter },
      ],
    };
    expect(tipTopicForProposal(proposal)).toBe("on_verify_fail");
    expect(tipForProposal(proposal)).toEqual(WORKSHOP_TIPS.on_verify_fail);
  });

  it("returns a tip for a new stage file by precedence", () => {
    expect(tipTopicForProposal({ artifacts: [{ after: json(reviewBefore) }] })).toBe("verify");
  });

  it("returns null when nothing matches", () => {
    const before = json({ id: "review", system_prompt: "a" });
    const after = json({ id: "review", system_prompt: "b" });
    expect(tipForProposal({ artifacts: [{ before, after }] })).toBeNull();
    expect(tipForProposal(null)).toBeNull();
    expect(tipForProposal({ artifacts: [] })).toBeNull();
  });

  it("keeps copy aligned with the catalog rules", () => {
    expect(WORKSHOP_TIPS.route.body).toContain("needs is rejected");
    expect(WORKSHOP_TIPS.ask_operator.body).toContain("gate_kinds");
    expect(WORKSHOP_TIPS.io.body).toContain("io.output.schema");
  });
});

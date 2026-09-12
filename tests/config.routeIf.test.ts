import { describe, expect, it } from "vitest";
import { parseRouteIf } from "../src/config/routeIf.js";
import { loadPipelineOutcome } from "../src/config/loadPipeline.js";
import { pipelinePath } from "./helpers/fixturePaths.js";

function parse(raw: unknown) {
  return parseRouteIf(raw, "triage", "page");
}

describe("parseRouteIf operators", () => {
  it.each(["eq", "ne", "gt", "gte", "lt", "lte"] as const)(
    "accepts op %s with a value",
    (op) => {
      const result = parse({ field: "score", op, value: 1 });
      expect(result).toEqual({
        ok: true,
        value: { field: "score", op, value: 1 },
      });
    },
  );

  it("accepts in with a non-empty list", () => {
    const result = parse({ field: "tier", op: "in", value: ["gold", "silver"] });
    expect(result).toEqual({
      ok: true,
      value: { field: "tier", op: "in", value: ["gold", "silver"] },
    });
  });

  it("accepts not_in with a non-empty list", () => {
    const result = parse({ field: "tier", op: "not_in", value: ["bronze"] });
    expect(result).toEqual({
      ok: true,
      value: { field: "tier", op: "not_in", value: ["bronze"] },
    });
  });

  it("rejects exists", () => {
    const result = parse({ field: "severity", op: "exists", value: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pipeline.route_if_invalid");
    expect(result.message).toMatch(/unknown op "exists"/);
  });

  it("rejects empty in list", () => {
    const result = parse({ field: "tier", op: "in", value: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pipeline.route_if_invalid");
  });

  it("rejects empty not_in list", () => {
    const result = parse({ field: "tier", op: "not_in", value: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pipeline.route_if_invalid");
  });

  it("rejects in when value is not a list", () => {
    const result = parse({ field: "tier", op: "in", value: "gold" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pipeline.route_if_invalid");
  });

  it("still requires value", () => {
    const result = parse({ field: "severity", op: "ne" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pipeline.route_if_invalid");
    expect(result.message).toMatch(/value is required/);
  });

  it("rejects unknown keys on a leaf", () => {
    const result = parse({
      field: "severity",
      op: "eq",
      value: "high",
      extra: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pipeline.route_if_invalid");
    expect(result.message).toMatch(/unknown key "extra"/);
  });
});

describe("parseRouteIf composition", () => {
  it("accepts all of leaves", () => {
    const result = parse({
      all: [
        { field: "severity", op: "eq", value: "high" },
        { field: "tier", op: "in", value: ["gold"] },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      all: [
        { field: "severity", op: "eq", value: "high" },
        { field: "tier", op: "in", value: ["gold"] },
      ],
    });
  });

  it("accepts any of alls", () => {
    const result = parse({
      any: [
        {
          all: [
            { field: "severity", op: "eq", value: "high" },
            { field: "source", op: "eq", value: "web" },
          ],
        },
        { field: "escalate", op: "eq", value: true },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("any" in result.value).toBe(true);
  });

  it("accepts not around all", () => {
    const result = parse({
      not: {
        all: [
          { field: "severity", op: "eq", value: "low" },
          { field: "source", op: "eq", value: "web" },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("not" in result.value).toBe(true);
  });

  it("rejects empty all", () => {
    const result = parse({ all: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pipeline.route_if_invalid");
  });

  it("rejects empty any", () => {
    const result = parse({ any: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pipeline.route_if_invalid");
  });

  it("rejects mixing leaf keys with all", () => {
    const result = parse({
      field: "severity",
      op: "eq",
      value: "high",
      all: [{ field: "severity", op: "eq", value: "high" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pipeline.route_if_invalid");
  });

  it("rejects unknown keys on a composition node", () => {
    const result = parse({
      all: [{ field: "severity", op: "eq", value: "high" }],
      extra: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pipeline.route_if_invalid");
    expect(result.message).toMatch(/unknown key "extra"/);
  });
});

describe("route if catalog fixtures", () => {
  it("nested required path loads", async () => {
    const outcome = await loadPipelineOutcome(pipelinePath("route-if-nested"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(
      (outcome.issues ?? []).some((issue) => issue.code === "pipeline.route_if_invalid"),
    ).toBe(false);
  });

  it("required $ref path loads", async () => {
    const outcome = await loadPipelineOutcome(pipelinePath("route-if-ref-required"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(
      (outcome.issues ?? []).some((issue) => issue.code === "pipeline.route_if_invalid"),
    ).toBe(false);
  });

  it("composition pipeline loads", async () => {
    const outcome = await loadPipelineOutcome(pipelinePath("route-if-composition"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(
      (outcome.issues ?? []).some((issue) => issue.code === "pipeline.route_if_invalid"),
    ).toBe(false);
  });

  it("two matching if targets stay distinct edges", async () => {
    const outcome = await loadPipelineOutcome(pipelinePath("route-if-two-match"));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const byId = new Map(outcome.value.dag.nodes.map((node) => [node.id, node]));
    expect(byId.get("page")?.needsEdges).toEqual([
      {
        id: "triage",
        on: ["succeeded"],
        if: { field: "severity", op: "eq", value: "high" },
      },
    ]);
    expect(byId.get("notify")?.needsEdges).toEqual([
      {
        id: "triage",
        on: ["succeeded"],
        if: { field: "escalate", op: "eq", value: true },
      },
    ]);
  });
});

describe("route if illegal combos", () => {
  it.each([
    ["route-if-on-loop", "review"],
    ["route-if-on-failed", "run-tests"],
    ["route-if-clonable", "triage"],
    ["route-if-clonable-sibling", "triage"],
  ] as const)("%s is pipeline.route_if_invalid not dag_error", async (fixture, stageId) => {
    const outcome = await loadPipelineOutcome(pipelinePath(fixture));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues.some((issue) => issue.code === "pipeline.dag_error")).toBe(false);
    expect(outcome.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "pipeline.route_if_invalid",
          category: "pipeline",
          pipelineId: fixture,
          stageId,
        }),
      ]),
    );
  });
});

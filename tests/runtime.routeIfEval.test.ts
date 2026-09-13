import { describe, expect, it } from "vitest";
import { evaluateRouteIf } from "../src/runtime/routeIfEval.js";

describe("evaluateRouteIf", () => {
  it("eq is type-strict: 1 is not \"1\"", () => {
    expect(
      evaluateRouteIf({ field: "n", op: "eq", value: 1 }, { n: "1" }),
    ).toBe("miss");
    expect(
      evaluateRouteIf({ field: "n", op: "eq", value: 1 }, { n: 1 }),
    ).toBe("fire");
  });

  it("ne fires when values differ", () => {
    expect(
      evaluateRouteIf({ field: "severity", op: "ne", value: "low" }, { severity: "high" }),
    ).toBe("fire");
    expect(
      evaluateRouteIf({ field: "severity", op: "ne", value: "low" }, { severity: "low" }),
    ).toBe("miss");
  });

  it.each([
    ["gt", 5, 10, "fire"],
    ["gt", 10, 5, "miss"],
    ["gte", 5, 5, "fire"],
    ["lt", 5, 1, "fire"],
    ["lte", 5, 5, "fire"],
  ] as const)("%s value %s vs payload %s → %s", (op, value, payload, expected) => {
    expect(evaluateRouteIf({ field: "n", op, value }, { n: payload })).toBe(expected);
  });

  it("numeric ops miss when the payload is not a number", () => {
    expect(evaluateRouteIf({ field: "n", op: "gt", value: 1 }, { n: "10" })).toBe("miss");
  });

  it("in means scalar membership, not array-contains", () => {
    expect(
      evaluateRouteIf({ field: "tier", op: "in", value: ["gold", "silver"] }, { tier: "gold" }),
    ).toBe("fire");
    expect(
      evaluateRouteIf({ field: "tier", op: "in", value: ["gold"] }, { tier: "bronze" }),
    ).toBe("miss");
    expect(
      evaluateRouteIf(
        { field: "tags", op: "in", value: ["gold"] },
        { tags: ["gold", "silver"] },
      ),
    ).toBe("miss");
  });

  it("not_in fires when the scalar is absent from the list", () => {
    expect(
      evaluateRouteIf({ field: "tier", op: "not_in", value: ["bronze"] }, { tier: "gold" }),
    ).toBe("fire");
    expect(
      evaluateRouteIf({ field: "tier", op: "not_in", value: ["gold"] }, { tier: "gold" }),
    ).toBe("miss");
  });

  it("walks nested object paths", () => {
    expect(
      evaluateRouteIf(
        { field: "customer.tier", op: "eq", value: "gold" },
        { customer: { tier: "gold" } },
      ),
    ).toBe("fire");
    expect(
      evaluateRouteIf(
        { field: "customer.tier", op: "eq", value: "gold" },
        { customer: { tier: "silver" } },
      ),
    ).toBe("miss");
  });

  it("missing intermediate object is missing_field", () => {
    expect(
      evaluateRouteIf({ field: "customer.tier", op: "eq", value: "gold" }, {}),
    ).toBe("missing_field");
    expect(
      evaluateRouteIf(
        { field: "customer.tier", op: "eq", value: "gold" },
        { customer: "gold" },
      ),
    ).toBe("missing_field");
  });

  it("all fires only when every child fires", () => {
    const predicate = {
      all: [
        { field: "severity", op: "eq" as const, value: "high" },
        { field: "tier", op: "in" as const, value: ["gold"] },
      ],
    };
    expect(evaluateRouteIf(predicate, { severity: "high", tier: "gold" })).toBe("fire");
    expect(evaluateRouteIf(predicate, { severity: "high", tier: "silver" })).toBe("miss");
  });

  it("any of alls fires when one group matches", () => {
    const predicate = {
      any: [
        {
          all: [
            { field: "severity", op: "eq" as const, value: "high" },
            { field: "source", op: "eq" as const, value: "web" },
          ],
        },
        { field: "escalate", op: "eq" as const, value: true },
      ],
    };
    expect(
      evaluateRouteIf(predicate, { severity: "low", source: "api", escalate: true }),
    ).toBe("fire");
    expect(
      evaluateRouteIf(predicate, { severity: "low", source: "api", escalate: false }),
    ).toBe("miss");
  });

  it("not around all inverts the group", () => {
    const predicate = {
      not: {
        all: [
          { field: "severity", op: "eq" as const, value: "low" },
          { field: "source", op: "eq" as const, value: "web" },
        ],
      },
    };
    expect(evaluateRouteIf(predicate, { severity: "low", source: "web" })).toBe("miss");
    expect(evaluateRouteIf(predicate, { severity: "high", source: "web" })).toBe("fire");
  });

  it("missing_field from a leaf propagates through composition", () => {
    const predicate = {
      all: [
        { field: "severity", op: "eq" as const, value: "high" },
        { field: "customer.tier", op: "eq" as const, value: "gold" },
      ],
    };
    expect(evaluateRouteIf(predicate, { severity: "high" })).toBe("missing_field");
    expect(
      evaluateRouteIf(
        {
          any: [{ field: "severity", op: "eq" as const, value: "high" }, { field: "missing", op: "eq" as const, value: 1 }],
        },
        { severity: "high" },
      ),
    ).toBe("missing_field");
    expect(
      evaluateRouteIf(
        { not: { field: "customer.tier", op: "eq" as const, value: "gold" } },
        {},
      ),
    ).toBe("missing_field");
  });
});

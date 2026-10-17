import { describe, expect, it } from "vitest";
import { parseAgentDefinition } from "../src/config/loadAgent.js";
import { defaultDefinition } from "../ui/src/redesign/agents/model/definition.js";

describe("console agent defaults", () => {
  it("match the server schema defaults exactly", () => {
    const parsed = parseAgentDefinition({ id: "a", name: "A", instructions: "x" });
    if (!parsed.ok) throw new Error("expected valid");
    expect({ ...defaultDefinition(), id: "a", name: "A", instructions: "x" }).toEqual(parsed.value);
  });
});

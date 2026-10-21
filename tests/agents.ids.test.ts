import { describe, expect, it } from "vitest";
import { RESERVED_AGENT_IDS } from "../src/agents/agentId.js";
import { SESSION_STATUSES, isSessionStatus } from "../src/agents/store.js";
import { parseAgentDefinition, parseAgentYaml } from "../src/config/loadAgent.js";

describe("reserved agent ids", () => {
  it.each([...RESERVED_AGENT_IDS])("rejects an explicit id of %s with a clear message", (id) => {
    const parsed = parseAgentDefinition({ id, name: "X", instructions: "x" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues[0]).toMatchObject({ path: "id", message: expect.stringContaining("reserved") });
    const yaml = parseAgentYaml(`id: ${id}\nname: X\ninstructions: x\n`);
    expect(yaml.ok).toBe(false);
  });

  it("still accepts ids that merely contain a reserved word", () => {
    expect(parseAgentDefinition({ id: "new_leads", name: "X", instructions: "x" }).ok).toBe(true);
  });
});

describe("session statuses", () => {
  it("come from one list", () => {
    expect(SESSION_STATUSES).toContain("open");
    expect(isSessionStatus("waiting")).toBe(true);
    expect(isSessionStatus("nope")).toBe(false);
  });
});

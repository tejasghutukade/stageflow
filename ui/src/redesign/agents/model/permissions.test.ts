import { describe, expect, it } from "vitest";
import { BUILTIN_PERMISSION_GROUPS, groupState, operatorOnlyToolNames, setGroup, setTool, stageflowPermissionGroups, toolGranted, type Grants } from "./permissions";

const read = BUILTIN_PERMISSION_GROUPS[0]!;
const none: Grants = { groups: [], tools: [] };

describe("permission grants", () => {
  it("ticking a group stores the group and clears its single tools", () => {
    const grants = setGroup({ groups: [], tools: ["grep", "bash"] }, read, true);
    expect(grants).toEqual({ groups: ["read"], tools: ["bash"] });
    expect(groupState(grants, read)).toBe("all");
    expect(toolGranted(grants, read, "ls")).toBe(true);
  });

  it("clearing a group clears every child", () => {
    expect(setGroup({ groups: ["read"], tools: [] }, read, false)).toEqual(none);
    expect(setGroup({ groups: [], tools: ["grep", "ls"] }, read, false)).toEqual(none);
  });

  it("ticking children one by one ends as the group", () => {
    let grants = setTool(none, read, "grep", true);
    expect(grants).toEqual({ groups: [], tools: ["grep"] });
    expect(groupState(grants, read)).toBe("some");
    grants = setTool(grants, read, "read", true);
    grants = setTool(grants, read, "find", true);
    grants = setTool(grants, read, "ls", true);
    expect(grants).toEqual({ groups: ["read"], tools: [] });
  });

  it("clearing one child of a full group keeps the others as single tools", () => {
    const grants = setTool({ groups: ["read"], tools: [] }, read, "grep", false);
    expect(grants).toEqual({ groups: [], tools: ["read", "find", "ls"] });
    expect(groupState(grants, read)).toBe("some");
  });

  it("leaves other groups' tools alone", () => {
    const grants = setTool({ groups: [], tools: ["bash"] }, read, "grep", true);
    expect(grants.tools).toEqual(["bash", "grep"]);
  });
});

describe("stageflow groups", () => {
  const catalog = {
    groups: [
      { id: "discover", title: "Discover", summary: "", operatorOnly: false, tools: [
        { name: "list_pipelines", grantId: "stageflow.list_pipelines", risk: "read" as const, description: "", operatorOnly: false },
        { name: "get_started", grantId: "stageflow.get_started", risk: "read" as const, description: "", operatorOnly: true },
      ] },
      { id: "gates.decide", title: "Decide", summary: "", operatorOnly: true, tools: [
        { name: "answer_gate", grantId: "stageflow.answer_gate", risk: "write" as const, description: "", operatorOnly: true },
      ] },
    ],
  };

  it("leaves operator-only tools and groups out of what an agent can pick", () => {
    const groups = stageflowPermissionGroups(catalog);
    expect(groups.map((g) => g.id)).toEqual(["discover"]);
    expect(groups[0]!.tools.map((t) => t.id)).toEqual(["list_pipelines"]);
    expect(operatorOnlyToolNames(catalog)).toEqual(["get_started", "answer_gate"]);
  });
});

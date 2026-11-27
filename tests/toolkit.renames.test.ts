import { describe, expect, it } from "vitest";
import { describeToolkit, grantedStageflowTools, TOOL_GROUPS, TOOL_META, toolsInGroup } from "../src/toolkit/index.js";
import {
  consolidatedToolsInGroup,
  derivedConsolidatedToolMeta,
  distinctNewToolNames,
  GRANT_PARITY_READ_ONLY_EXCEPTIONS,
  grantParityBeforeGroup,
  TOOL_RENAMES,
} from "../src/toolkit/toolRenames.js";
import { isOperatorOnlyGroup, type ToolGroupId } from "../src/toolkit/meta.js";
import { resolveMode } from "../src/toolkit/modes.js";

describe("tool rename table", () => {
  it("maps every TOOL_META name exactly once", () => {
    for (const name of Object.keys(TOOL_META)) {
      if (TOOL_RENAMES[name]) continue;
      const isConsolidatedName = Object.values(TOOL_RENAMES).some((entry) => entry.newTool === name);
      expect(isConsolidatedName, `TOOL_META ${name} is neither old nor consolidated`).toBe(true);
    }
    for (const [oldName, entry] of Object.entries(TOOL_RENAMES)) {
      if (TOOL_META[oldName]) continue;
      expect(TOOL_META[entry.newTool], `missing consolidated meta for ${entry.newTool}`).toBeDefined();
    }
  });

  it("defines exactly 63 consolidated tools", () => {
    expect(distinctNewToolNames().length).toBe(63);
  });

  it("gives every absorbed old tool the same risk and operatorOnly on each new tool", () => {
    const byNew = new Map<string, string[]>();
    for (const [oldName, entry] of Object.entries(TOOL_RENAMES)) {
      const list = byNew.get(entry.newTool) ?? [];
      list.push(oldName);
      byNew.set(entry.newTool, list);
    }
    for (const [newTool, olds] of byNew) {
      const risks = new Set(
        olds.map((name) => (TOOL_META[name] ?? TOOL_META[newTool])!.risk),
      );
      const operatorFlags = new Set(
        olds.map((name) => (TOOL_META[name] ?? TOOL_META[newTool])!.operatorOnly === true),
      );
      expect(risks.size, `${newTool} risk mismatch`).toBe(1);
      expect(operatorFlags.size, `${newTool} operatorOnly mismatch`).toBe(1);
      const consolidated = derivedConsolidatedToolMeta()[newTool]!;
      expect(consolidated.risk).toBe([...risks][0]);
      if ([...operatorFlags][0]) expect(consolidated.operatorOnly).toBe(true);
      else expect(consolidated.operatorOnly).toBeUndefined();
    }
  });

  it("names the accepted read-only grant-parity exceptions", () => {
    expect(GRANT_PARITY_READ_ONLY_EXCEPTIONS.validate).toContain("validate");
    expect(GRANT_PARITY_READ_ONLY_EXCEPTIONS.read_pipeline).toContain("describe_pipeline");
    const consolidated = derivedConsolidatedToolMeta();
    expect(consolidated.validate!.groups.length).toBeGreaterThan(1);
    expect(consolidated.read_pipeline!.groups).toEqual(expect.arrayContaining(["discover", "pipelines.author"]));
  });

  it("discover grant widens validate across former grant groups", () => {
    const tools = grantedStageflowTools({ groups: ["discover"], tools: [] });
    expect(tools).toContain("validate");
    expect(resolveMode("validate", { kind: "catalog" })).toMatchObject({ ok: true, resolved: { mode: "catalog" } });
    expect(resolveMode("validate", { kind: "agent", definition: { id: "boss" } })).toMatchObject({
      ok: true,
      resolved: { mode: "agent" },
    });
    expect(resolveMode("validate", { kind: "eval", eval_id: "review" })).toMatchObject({
      ok: true,
      resolved: { mode: "eval" },
    });
    expect(resolveMode("validate", { kind: "connection_recipient", id: "slack", to: "u1" })).toMatchObject({
      ok: true,
      resolved: { mode: "connection_recipient" },
    });
  });

  it("pipelines.author grant widens read_pipeline dag view from discover", () => {
    const tools = grantedStageflowTools({ groups: ["pipelines.author"], tools: [] });
    expect(tools).toContain("read_pipeline");
    expect(resolveMode("read_pipeline", { path: "pipelines/hello.pipeline.yaml", view: "dag" })).toMatchObject({
      ok: true,
      resolved: { mode: "dag" },
    });
  });

  it("keeps per-group grant parity for mapped tool names", () => {
    for (const group of TOOL_GROUPS) {
      if (group.operatorOnly) continue;
      const before = grantParityBeforeGroup(group.id);
      const after = consolidatedToolsInGroup(group.id);
      expect(after, group.id).toEqual(before);
    }
  });

  it("never mixes an operator-only group with a grantable group on one tool", () => {
    for (const meta of Object.values(derivedConsolidatedToolMeta())) {
      const hasOperatorGroup = meta.groups.some((group) => isOperatorOnlyGroup(group));
      const hasGrantableGroup = meta.groups.some((group) => !isOperatorOnlyGroup(group));
      expect(hasOperatorGroup && hasGrantableGroup).toBe(false);
    }
    for (const meta of Object.values(TOOL_META)) {
      const hasOperatorGroup = meta.groups.some((group) => isOperatorOnlyGroup(group));
      const hasGrantableGroup = meta.groups.some((group) => !isOperatorOnlyGroup(group));
      expect(hasOperatorGroup && hasGrantableGroup).toBe(false);
    }
  });

  it("still matches toolsInGroup until MCP tools are renamed", () => {
    for (const group of TOOL_GROUPS) {
      if (group.operatorOnly) continue;
      expect(toolsInGroup(group.id).sort()).toEqual(
        Object.entries(TOOL_META)
          .filter(([, meta]) => meta.groups.includes(group.id))
          .map(([name]) => name)
          .filter((name) => !(TOOL_META[name]!.operatorOnly === true || TOOL_META[name]!.groups.some((g) => isOperatorOnlyGroup(g))))
          .sort(),
      );
    }
  });
});

describe("describeToolkit catalog", () => {
  it("returns the group catalog the console picker reads", () => {
    const catalog = describeToolkit();
    expect(catalog.groups.length).toBe(TOOL_GROUPS.length);
    for (const group of catalog.groups) {
      const expected = Object.entries(TOOL_META)
        .filter(([, meta]) => meta.groups.includes(group.id as ToolGroupId))
        .map(([name]) => (name === "save_artifact" ? "publish_artifact" : name))
        .sort();
      expect(group.tools.map((tool) => tool.name).sort()).toEqual(expected);
      expect(group.operatorOnly).toBe(TOOL_GROUPS.find((entry) => entry.id === group.id)?.operatorOnly === true);
    }
  });
});
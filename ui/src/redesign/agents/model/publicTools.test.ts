import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../../api/agents";
import { defaultDefinition } from "./definition";
import type { StageflowToolCatalog } from "../../../api/agents";
import { applyAskFirst, identityOnlyToolLabels, sideEffectingGrantIds, visitorToolLines, wildcardMcpServers } from "./publicTools";

const catalog = {
  groups: [
    {
      id: "runs.control",
      title: "Runs",
      summary: "",
      operatorOnly: false,
      tools: [{ name: "start_run", grantId: "stageflow.start_run", risk: "write", description: "", operatorOnly: false }],
    },
    {
      id: "pipelines.author",
      title: "Author",
      summary: "",
      operatorOnly: false,
      tools: [
        { name: "read_pipeline", grantId: "stageflow.read_pipeline", risk: "read", description: "", operatorOnly: false },
        { name: "write_stage", grantId: "stageflow.write_stage", risk: "write", description: "", operatorOnly: false },
      ],
    },
  ],
  toolsets: [],
} as unknown as StageflowToolCatalog;

describe("public tools form helpers", () => {
  it("lists identity-only and visitor tools", () => {
    const def: AgentDefinition = {
      ...defaultDefinition(),
      tools: {
        ...defaultDefinition().tools,
        builtin: ["read"],
        mcp: { notion: ["search"] },
        browser: true,
      },
    };
    expect(identityOnlyToolLabels(def).sort()).toEqual(["browser", "find", "grep", "ls", "read"].sort());
    expect(visitorToolLines(def)).toEqual(["MCP notion (search) — visitors use your notion connection"]);
  });

  it("merges suggested ask_first grants", () => {
    const def = defaultDefinition();
    const next = applyAskFirst(def, ["web.fetch"]);
    expect(next.approvals.ask_first).toEqual(["web.fetch"]);
  });

  it("suggests per-tool Ask first ids visitors can reach, never groups, withheld tools or wildcards", () => {
    const base = defaultDefinition();
    const def: AgentDefinition = {
      ...base,
      tools: {
        ...base.tools,
        builtin: ["shell"],
        browser: true,
        mcp: { notion: ["search"], github: ["*"] },
        stageflow: { groups: ["runs.control", "pipelines.author"], tools: [] },
      },
    };
    expect(sideEffectingGrantIds(def, catalog)).toEqual(["notion.search", "stageflow.start_run"]);
    expect(wildcardMcpServers(def)).toEqual(["github"]);
    expect(identityOnlyToolLabels(def, catalog)).toEqual(["bash", "browser", "write_stage"]);
  });
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchInternalAgents, HIDDEN_INTERNAL_AGENTS, type InternalAgentsResponse } from "../../api/internalAgents";
import { InternalAgentTargetsView } from "../evals/newEval/InternalAgentTargets";
import { InternalAgentsView } from "./InternalAgentsSection";

const VISIBLE: InternalAgentsResponse = {
  visible: true,
  agents: [
    { id: "stageflow-guide", title: "Stageflow Guide", greeting: "Hi", playbook: "Help the operator.", tools: ["list_pipelines", "create_pipeline"] },
    { id: "agent-author", title: "Agent author", playbook: "Draft agents.", tools: ["update_agent_draft"] },
  ],
};

const noop = () => {};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("internal agents on the Agents page", () => {
  it("renders nothing when hidden", () => {
    expect(renderToStaticMarkup(createElement(InternalAgentsView, { data: HIDDEN_INTERNAL_AGENTS, openId: null, onOpen: noop, onClose: noop }))).toBe("");
  });

  it("lists each internal agent with title, id and tool count, read-only", () => {
    const html = renderToStaticMarkup(createElement(InternalAgentsView, { data: VISIBLE, openId: null, onOpen: noop, onClose: noop }));
    expect(html).toContain('data-testid="internal-agents"');
    expect(html).toContain("Internal agents");
    expect(html).toContain("read-only");
    expect(html).toContain("Stageflow Guide");
    expect(html).toContain("stageflow-guide");
    expect(html).toContain("2 tools");
    expect(html).toContain("1 tool<");
    expect(html).not.toContain("internal-agent-detail");
    for (const control of ["Edit", "Enable", "Disable", "Archive", "Chat"]) expect(html).not.toContain(`>${control}<`);
  });

  it("opens a read-only detail with the playbook and tool names", () => {
    const html = renderToStaticMarkup(createElement(InternalAgentsView, { data: VISIBLE, openId: "stageflow-guide", onOpen: noop, onClose: noop }));
    expect(html).toContain('data-testid="internal-agent-detail"');
    expect(html).toContain("Help the operator.");
    expect(html).toContain("create_pipeline");
    expect(html).toContain("list_pipelines");
  });
});

describe("internal agents in the eval agent picker", () => {
  it("renders nothing when hidden", () => {
    expect(renderToStaticMarkup(createElement(InternalAgentTargetsView, { data: HIDDEN_INTERNAL_AGENTS, query: "" }))).toBe("");
  });

  it("lists internal agents as selectable targets and filters by the search", () => {
    const html = renderToStaticMarkup(createElement(InternalAgentTargetsView, { data: VISIBLE, query: "guide" }));
    expect(html).toContain("Internal");
    expect(html).toContain("read-only");
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain("not runnable");
    expect(html).toContain("stageflow-guide");
    expect(html).not.toContain("agent-author");
  });
});

describe("fetchInternalAgents", () => {
  it("reads a failed or hidden response as hidden", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    expect(await fetchInternalAgents()).toEqual(HIDDEN_INTERNAL_AGENTS);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await fetchInternalAgents()).toEqual(HIDDEN_INTERNAL_AGENTS);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ visible: false, agents: [] })));
    expect(await fetchInternalAgents()).toEqual(HIDDEN_INTERNAL_AGENTS);
  });

  it("returns the agents when visible", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(VISIBLE)));
    expect(await fetchInternalAgents()).toEqual(VISIBLE);
  });
});

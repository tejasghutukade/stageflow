import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resetAgentAuthorSessionsForTests } from "../src/agents/authorChat.js";
import { mergeDraftPatch } from "../src/operatorAgent/profiles/agentAuthor.js";
import {
  createAgentAuthorContext,
  createAgentAuthorProfile,
  createWorkshopOperatorHost,
  readAgentAuthorDraft,
} from "../src/operatorAgent/index.js";

describe("agent author", () => {
  it("applies a draft through the operator host and undoes it", async () => {
    const host = createWorkshopOperatorHost([
      {
        type: "call_tool",
        name: "update_agent_draft",
        args: { patch: { name: "Scout", instructions: "1. Search.\n2. Check.", approvals: { ask_first: ["bash"] } } },
        message: "I drafted Scout. It starts sealed.",
      },
    ]);
    const session = host.openSession({
      profileId: "agent-author",
      context: createAgentAuthorContext({ projectRoot: "/tmp/project" }),
    });
    const events = await session.send("A scout that searches.");
    expect(events.some((event) => event.type === "message")).toBe(true);
    expect(readAgentAuthorDraft(session.getContext())).toMatchObject({ id: "scout", name: "Scout" });
    const toolResult = events.find((event) => event.type === "tool_result");
    expect(JSON.stringify(toolResult)).toContain("bash is not a tool this agent is granted");
    expect(session.undoMutation().ok).toBe(true);
    expect(readAgentAuthorDraft(session.getContext())).toEqual({});
    session.close();
    resetAgentAuthorSessionsForTests();
  });

  it("reads a project file and refuses paths outside it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-agent-author-"));
    await writeFile(path.join(root, "AGENTS.md"), "project notes");
    const profile = createAgentAuthorProfile();
    const read = profile.tools.find((tool) => tool.name === "read_project_file");
    const list = profile.tools.find((tool) => tool.name === "list_project_files");
    let context = createAgentAuthorContext({ projectRoot: root });
    const ctx = {
      getContext: () => context,
      setContext: (next: unknown) => {
        context = next as typeof context;
      },
      emitProposal: () => undefined,
    };
    const merged = mergeDraftPatch(
      { tools: { builtin: ["read"], mcp: { notion: ["search"] } }, greeting: "hi" },
      { tools: { mcp: { slack: ["*"] } }, greeting: null },
    );
    expect(merged).toEqual({ tools: { builtin: ["read"], mcp: { notion: ["search"], slack: ["*"] } } });
    const listed = await list!.handler({}, ctx);
    expect(listed).toMatchObject({ ok: true, content: { files: ["AGENTS.md"] } });
    const file = await read!.handler({ path: "AGENTS.md" }, ctx);
    expect(file).toMatchObject({ ok: true, content: { text: "project notes" } });
    const escaped = await read!.handler({ path: "../secrets.env" }, ctx);
    expect(escaped.ok).toBe(false);
  });
});

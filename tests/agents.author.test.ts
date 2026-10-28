import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  forgetAgentAuthorSession,
  resetAgentAuthorSessionsForTests,
  runAgentAuthorTurn,
} from "../src/agents/authorChat.js";
import {
  createAuthorSession,
  deleteAuthorSession,
  listAuthorDrafts,
  readAuthorSession,
  saveAuthorSession,
} from "../src/agents/authorSessionStore.js";
import { invokeProfileTool, type OperatorAgentModel } from "../src/operatorAgent/host.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";
import {
  formatAgentAuthorTurnPrompt,
  mergeDraftPatch,
} from "../src/operatorAgent/profiles/agentAuthor.js";
import {
  createAgentAuthorContext,
  createAgentAuthorProfile,
  AGENT_AUTHOR_TOOL_NAMES,
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
    await mkdir(path.join(root, "policies"), { recursive: true });
    await writeFile(path.join(root, "policies", "data-handling.md"), "keep records 24 months");
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(path.join(root, "docs", "secret.ts"), "export const key = 1");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "cli.ts"), "code");
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
    expect(listed).toMatchObject({ ok: true, content: { files: ["AGENTS.md", "policies/data-handling.md"] } });
    const file = await read!.handler({ path: "AGENTS.md" }, ctx);
    expect(file).toMatchObject({ ok: true, content: { text: "project notes" } });
    const policy = await read!.handler({ path: "policies/data-handling.md" }, ctx);
    expect(policy).toMatchObject({ ok: true, content: { text: "keep records 24 months" } });
    const escaped = await read!.handler({ path: "../secrets.env" }, ctx);
    expect(escaped.ok).toBe(false);
    const source = await read!.handler({ path: "src/cli.ts" }, ctx);
    expect(source.ok).toBe(false);
    const codeInDocs = await read!.handler({ path: "docs/secret.ts" }, ctx);
    expect(codeInDocs.ok).toBe(false);
    const catalog = profile.tools.find((tool) => tool.name === "list_author_catalog");
    const listedCatalog = await catalog!.handler({}, ctx);
    expect(listedCatalog.ok).toBe(true);
    expect(listedCatalog).toMatchObject({ content: { connections: [] } });
    expect(AGENT_AUTHOR_TOOL_NAMES).not.toContain("bash");
    expect(AGENT_AUTHOR_TOOL_NAMES).not.toContain("write");
    expect(AGENT_AUTHOR_TOOL_NAMES).not.toContain("edit");
  });

  it("applies update_agent_draft when patch is YAML text", async () => {
    const profile = createAgentAuthorProfile();
    const update = profile.tools.find((tool) => tool.name === "update_agent_draft");
    let context = createAgentAuthorContext({ projectRoot: "/tmp/project" });
    const proposals: unknown[] = [];
    const ctx = {
      getContext: () => context,
      setContext: (next: unknown) => {
        context = next as typeof context;
      },
      emitProposal: (proposal: unknown) => {
        proposals.push(proposal);
        context = profile.contextAdapter.applyProposal(context, proposal as never);
      },
    };
    const yaml = [
      "name: Compliance",
      "instructions: |",
      "  Compare documents to policies.",
    ].join("\n");
    const result = await update!.handler({ patch: yaml, summary: "Drafted compliance agent" }, ctx);
    expect(result.ok).toBe(true);
    expect(readAgentAuthorDraft(context)).toMatchObject({
      id: "compliance",
      name: "Compliance",
      instructions: "Compare documents to policies.\n",
    });
  });

  it("merges a known-field update_agent_draft patch and rejects unknown keys", async () => {
    const profile = createAgentAuthorProfile();
    const update = profile.tools.find((tool) => tool.name === "update_agent_draft");
    let context = createAgentAuthorContext({
      projectRoot: "/tmp/project",
      draft: { name: "Scout", instructions: "Search." },
    });
    const ctx = {
      getContext: () => context,
      setContext: (next: unknown) => {
        context = next as typeof context;
      },
      emitProposal: (proposal: unknown) => {
        context = profile.contextAdapter.applyProposal(context, proposal as never);
      },
    };
    const ok = await update!.handler(
      { patch: { name: "Scout", instructions: "1. Search.\n2. Check.", greeting: "Ready." }, summary: "Filled Scout" },
      ctx,
    );
    expect(ok.ok).toBe(true);
    expect(readAgentAuthorDraft(context)).toMatchObject({
      id: "scout",
      name: "Scout",
      instructions: "1. Search.\n2. Check.",
      greeting: "Ready.",
    });
    const before = readAgentAuthorDraft(context);
    const bad = await update!.handler({ patch: { name: "Scout", mystery: true }, summary: "Bad field" }, ctx);
    expect(bad).toMatchObject({ ok: false, error: "unknown patch field: mystery" });
    expect(readAgentAuthorDraft(context)).toEqual(before);
  });

  it("includes the current draft in the turn prompt envelope", () => {
    const prompt = formatAgentAuthorTurnPrompt(
      "Make a scout agent",
      createAgentAuthorContext({ projectRoot: "/p", draft: { name: "Scout" } }),
    );
    expect(prompt).toContain("Make a scout agent");
    expect(prompt).toContain('"name": "Scout"');
    expect(prompt).toContain("update_agent_draft");
    expect(prompt).toContain("Ask until the job is clear");
  });

  it("sends the composer model on the author turn", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-agent-author-model-"));
    bindStageflowHomeForTests(home);
    const seen: Array<string | undefined> = [];
    const model: OperatorAgentModel = {
      async complete(input) {
        seen.push(input.modelId);
        return { events: [{ type: "message", role: "assistant", text: "What is a good result?" }] };
      },
    };
    const host = createWorkshopOperatorHost({ model });
    await runAgentAuthorTurn({
      host,
      projectRoot: "/tmp/project",
      message: "A compliance reviewer.",
      model: "openrouter/test-model",
    });
    expect(seen).toEqual(["openrouter/test-model"]);
    resetAgentAuthorSessionsForTests();
  });

  it("reloads the draft and transcript after the in-memory session is gone", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-agent-author-resume-"));
    bindStageflowHomeForTests(home);
    const model: OperatorAgentModel = {
      async complete() {
        return { events: [{ type: "message", role: "assistant", text: "Who is it for?" }] };
      },
    };
    const host = createWorkshopOperatorHost({ model });
    const first = await runAgentAuthorTurn({
      host,
      projectRoot: "/tmp/project",
      message: "A compliance reviewer.",
      draft: { name: "Compliance" },
    });
    expect(readAuthorSession(first.sessionId)?.transcript).toHaveLength(2);
    resetAgentAuthorSessionsForTests();
    const second = await runAgentAuthorTurn({
      host,
      projectRoot: "/tmp/project",
      message: "People pasting contracts.",
      sessionId: first.sessionId,
      draft: { name: "Compliance" },
    });
    expect(second.sessionId).toBe(first.sessionId);
    expect(readAuthorSession(first.sessionId)?.draft).toMatchObject({ name: "Compliance" });
    expect(readAuthorSession(first.sessionId)?.transcript).toHaveLength(4);
    resetAgentAuthorSessionsForTests();
  });

  it("lists named drafts and skips empty shells", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-agent-author-list-"));
    bindStageflowHomeForTests(home);
    createAuthorSession({ draft: {} });
    const named = createAuthorSession({ draft: { name: "Scout" } });
    const listed = listAuthorDrafts(home);
    expect(listed.map((draft) => draft.id)).toEqual([named.id]);
    expect(listed[0]).toMatchObject({ name: "Scout", messages: 0 });
  });

  it("deletes an author session from disk and drops it from the draft list", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-agent-author-delete-"));
    bindStageflowHomeForTests(home);
    const created = createAuthorSession({ draft: { name: "Scout" } });
    expect(listAuthorDrafts(home).map((draft) => draft.id)).toEqual([created.id]);
    expect(deleteAuthorSession(created.id, home)).toBe(true);
    expect(readAuthorSession(created.id, home)).toBeNull();
    expect(listAuthorDrafts(home)).toEqual([]);
    expect(deleteAuthorSession(created.id, home)).toBe(false);
    expect(deleteAuthorSession("../escape", home)).toBe(false);
  });

  it("forgets an in-memory author chat when the session is deleted", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-agent-author-forget-"));
    bindStageflowHomeForTests(home);
    const host = createWorkshopOperatorHost({
      model: {
        async complete() {
          return { events: [{ type: "message", role: "assistant", text: "Who is it for?" }] };
        },
      },
    });
    const first = await runAgentAuthorTurn({
      host,
      projectRoot: "/tmp/project",
      message: "A scout.",
      draft: { name: "Scout" },
    });
    forgetAgentAuthorSession(first.sessionId);
    expect(deleteAuthorSession(first.sessionId, home)).toBe(true);
    await expect(
      runAgentAuthorTurn({
        host,
        projectRoot: "/tmp/project",
        message: "Again.",
        sessionId: first.sessionId,
        draft: { name: "Scout" },
      }),
    ).rejects.toThrow("agent.session_not_found");
    resetAgentAuthorSessionsForTests();
  });

  it("keeps a disk edit made during a question-only turn and appends both transcript lines", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-agent-author-overlap-"));
    bindStageflowHomeForTests(home);
    const created = createAuthorSession({ draft: { name: "Scout", instructions: "Search." } });
    const model: OperatorAgentModel = {
      async complete() {
        const current = readAuthorSession(created.id);
        if (!current) throw new Error("session missing");
        saveAuthorSession({
          ...current,
          draft: { ...current.draft, instructions: "Operator rewrote this." },
        });
        return { events: [{ type: "message", role: "assistant", text: "Who is it for?" }] };
      },
    };
    const host = createWorkshopOperatorHost({ model });
    const result = await runAgentAuthorTurn({
      host,
      projectRoot: "/tmp/project",
      message: "What should it do?",
      sessionId: created.id,
    });
    const saved = readAuthorSession(created.id);
    expect(saved?.draft).toEqual({ name: "Scout", instructions: "Operator rewrote this." });
    expect(saved?.transcript.map((entry) => entry.text)).toEqual(["What should it do?", "Who is it for?"]);
    expect(result.draft).toEqual({ name: "Scout", instructions: "Operator rewrote this." });
    expect(result.summaryLines).toEqual([]);
    resetAgentAuthorSessionsForTests();
  });

  it("writes the turn's name and keeps instructions changed on disk during the turn", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-agent-author-name-"));
    bindStageflowHomeForTests(home);
    const created = createAuthorSession({
      draft: { id: "scout", name: "Old", instructions: "Search." },
    });
    const host = createWorkshopOperatorHost({
      model: {
        async complete(input) {
          writeDiskDraft(created.id, { id: "scout", name: "Old", instructions: "Disk instructions." });
          await invokeProfileTool(
            input.profile,
            "update_agent_draft",
            { patch: { name: "Scout" }, summary: "Named it" },
            input.tools,
          );
          return { events: [{ type: "message", role: "assistant", text: "Named Scout." }] };
        },
      },
    });
    const result = await runAgentAuthorTurn({
      host,
      projectRoot: "/tmp/project",
      message: "Call it Scout.",
      sessionId: created.id,
    });
    const saved = readAuthorSession(created.id);
    expect(saved?.draft).toEqual({ id: "scout", name: "Scout", instructions: "Disk instructions." });
    expect(result.draft).toEqual({ id: "scout", name: "Scout", instructions: "Disk instructions." });
    expect(result.summaryLines).toEqual([{ label: "Identity", value: "Scout · scout" }]);
    expect(saved?.transcript.at(-1)?.summaryLines).toEqual([{ label: "Identity", value: "Scout · scout" }]);
    resetAgentAuthorSessionsForTests();
  });

  it("keeps the turn's name when the operator also changed the name", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-agent-author-both-name-"));
    bindStageflowHomeForTests(home);
    const created = createAuthorSession({ draft: { id: "scout", name: "Old", instructions: "Search." } });
    const host = createWorkshopOperatorHost({
      model: {
        async complete(input) {
          writeDiskDraft(created.id, { id: "scout", name: "Operator", instructions: "Search." });
          await invokeProfileTool(
            input.profile,
            "update_agent_draft",
            { patch: { name: "Scout" }, summary: "Named it" },
            input.tools,
          );
          return { events: [{ type: "message", role: "assistant", text: "Named Scout." }] };
        },
      },
    });
    const result = await runAgentAuthorTurn({
      host,
      projectRoot: "/tmp/project",
      message: "Call it Scout.",
      sessionId: created.id,
    });
    const saved = readAuthorSession(created.id);
    expect(saved?.draft).toEqual({ id: "scout", name: "Scout", instructions: "Search." });
    expect(result.draft).toEqual(saved?.draft);
    resetAgentAuthorSessionsForTests();
  });

  it("drops a field the turn removed even if disk still has it", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-agent-author-remove-"));
    bindStageflowHomeForTests(home);
    const created = createAuthorSession({
      draft: { id: "scout", name: "Scout", greeting: "hi", instructions: "Search." },
    });
    const host = createWorkshopOperatorHost({
      model: {
        async complete(input) {
          writeDiskDraft(created.id, {
            id: "scout",
            name: "Scout",
            greeting: "operator hello",
            instructions: "Disk instructions.",
          });
          await invokeProfileTool(
            input.profile,
            "update_agent_draft",
            { patch: { greeting: null }, summary: "Removed the greeting" },
            input.tools,
          );
          return { events: [{ type: "message", role: "assistant", text: "Removed the greeting." }] };
        },
      },
    });
    const result = await runAgentAuthorTurn({
      host,
      projectRoot: "/tmp/project",
      message: "Drop the greeting.",
      sessionId: created.id,
    });
    const saved = readAuthorSession(created.id);
    expect(saved?.draft).toEqual({ id: "scout", name: "Scout", instructions: "Disk instructions." });
    expect(result.draft).toEqual(saved?.draft);
    resetAgentAuthorSessionsForTests();
  });

  it("appends the user line and the error text and still merges the disk draft", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "sf-agent-author-error-"));
    bindStageflowHomeForTests(home);
    const created = createAuthorSession({
      draft: { id: "scout", name: "Old", instructions: "Search." },
    });
    const host = createWorkshopOperatorHost({
      model: {
        async complete(input) {
          writeDiskDraft(created.id, { id: "scout", name: "Old", instructions: "Disk instructions." });
          await invokeProfileTool(
            input.profile,
            "update_agent_draft",
            { patch: { name: "Scout" }, summary: "Named it" },
            input.tools,
          );
          return { events: [{ type: "error", message: "provider down" }] };
        },
      },
    });
    const result = await runAgentAuthorTurn({
      host,
      projectRoot: "/tmp/project",
      message: "Call it Scout.",
      sessionId: created.id,
    });
    const saved = readAuthorSession(created.id);
    expect(saved?.draft).toEqual({ id: "scout", name: "Scout", instructions: "Disk instructions." });
    expect(result.draft).toEqual(saved?.draft);
    expect(saved?.transcript.map((entry) => entry.text)).toEqual(["Call it Scout.", "provider down"]);
    expect(result.summaryLines).toEqual([{ label: "Identity", value: "Scout · scout" }]);
    resetAgentAuthorSessionsForTests();
  });
});

function writeDiskDraft(sessionId: string, draft: Record<string, unknown>): void {
  const current = readAuthorSession(sessionId);
  if (!current) throw new Error("session missing");
  saveAuthorSession({ ...current, draft });
}

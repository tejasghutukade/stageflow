import { describe, expect, it } from "vitest";
import {
  createFailingDocsRetriever,
  createFilesystemDocsRetriever,
  createStubDocsRetriever,
  createWorkshopAuthorProfile,
  createWorkshopDraftContext,
  createWorkshopOperatorHost,
  emptyDraftPackage,
  invokeProfileTool,
  readDraftFromContext,
  WORKSHOP_AUTHOR_PLAYBOOK,
  WORKSHOP_AUTHOR_PROFILE_ID,
  type DocsRetrievalResult,
  type OperatorAgentToolContext,
} from "../src/operatorAgent/index.js";

function emptyToolContext(): OperatorAgentToolContext {
  let context: unknown = createWorkshopDraftContext(emptyDraftPackage("demo"));
  return {
    getContext: () => context,
    setContext: (next) => {
      context = next;
    },
    emitProposal: () => {},
  };
}

describe("Workshop Author playbook + docs retrieval", () => {
  it("bakes core-path and explain-only guidance into the Author playbook", () => {
    const playbook = WORKSHOP_AUTHOR_PLAYBOOK;
    expect(playbook).toMatch(/route/i);
    expect(playbook).toMatch(/entry/i);
    expect(playbook).toMatch(/\bio\b/);
    expect(playbook).toMatch(/\bverify\b/);
    expect(playbook).toMatch(/on_verify_fail/);
    expect(playbook).toMatch(/ask_operator/);
    expect(playbook).toMatch(/emit_stage_envelope/);
    expect(playbook).toMatch(/artifact/i);
    expect(playbook).toMatch(/envelope/i);
    expect(playbook).toMatch(/Clone Chain/i);
    expect(playbook).toMatch(/feedback_loop|type: loop/i);
    expect(playbook).toMatch(/Stage MCP|\.mcp\.json/i);
    expect(playbook).toMatch(/recover|recovery/i);
    expect(playbook).toMatch(/explain-only|no first-class Workshop editors/i);
  });

  it("wires primary Author tools and excludes disk/shell builtins", () => {
    const profile = createWorkshopAuthorProfile();
    expect(profile.playbook).toBe(WORKSHOP_AUTHOR_PLAYBOOK);
    expect(profile.tools.map((t) => t.name)).toEqual([
      "read_draft",
      "validate_draft",
      "create_pipeline",
      "edit_pipeline",
      "create_stage",
      "edit_stage",
      "create_task",
      "edit_task",
      "save",
      "propose_draft",
      "retrieve_docs",
    ]);
    for (const forbidden of ["bash", "write", "edit"] as const) {
      expect(profile.tools.some((t) => t.name === forbidden)).toBe(false);
    }
    expect(profile.playbook).toMatch(/clarify-then-create|clarify/i);
    expect(profile.playbook).toMatch(/create_stage/);
    expect(profile.playbook).toMatch(/never use bash\/write\/edit/i);
    expect(profile.playbook).toMatch(/immediately/i);
    expect(profile.playbook).toMatch(/soft-undos|soft undo/i);
    expect(profile.playbook).toMatch(/workshop\/sessions/i);
  });

  it("retrieves stubbed docs/examples without a live provider", async () => {
    const stubHits = [
      {
        path: "docs/yaml-catalog.md",
        kind: "doc" as const,
        title: "YAML catalog",
        excerpt: "Stub Clone Chain guidance",
      },
    ];
    const host = createWorkshopOperatorHost({
      script: [
        {
          type: "call_tool",
          name: "retrieve_docs",
          args: { query: "clone chain" },
        },
      ],
      retriever: createStubDocsRetriever(stubHits),
    });
    const profile = host.getProfile(WORKSHOP_AUTHOR_PROFILE_ID)!;
    expect(profile.tools.some((t) => t.name === "retrieve_docs")).toBe(true);

    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });
    const events = await session.send("explain clone chain");
    const toolEvent = events.find((e) => e.type === "tool_result");
    expect(toolEvent?.type).toBe("tool_result");
    if (toolEvent?.type !== "tool_result") return;
    expect(toolEvent.name).toBe("retrieve_docs");
    expect(toolEvent.result.ok).toBe(true);
    const content = toolEvent.result.content as DocsRetrievalResult;
    expect(content.hits).toEqual(stubHits);
  });

  it("degrades gracefully when retrieval fails and still proposes from the baked playbook", async () => {
    const host = createWorkshopOperatorHost({
      script: [
        {
          type: "call_tool",
          name: "retrieve_docs",
          args: { query: "stage mcp" },
        },
        { type: "propose_stage" },
      ],
      retriever: createFailingDocsRetriever("stub offline"),
    });
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    const failed = await session.send("what is stage mcp?");
    const toolEvent = failed.find((e) => e.type === "tool_result");
    expect(toolEvent?.type).toBe("tool_result");
    if (toolEvent?.type === "tool_result") {
      expect(toolEvent.result.ok).toBe(false);
      expect(toolEvent.result.error).toMatch(/stub offline/);
    }
    expect(
      failed.some(
        (e) =>
          e.type === "message" &&
          e.role === "assistant" &&
          /baked Workshop Author playbook/i.test(e.text),
      ),
    ).toBe(true);

    const proposed = await session.send("intake form review");
    expect(proposed.some((e) => e.type === "proposal")).toBe(true);
    expect(readDraftFromContext(session.getContext()).pipeline.stages.length).toBe(
      1,
    );
    expect(session.acceptProposal()).toEqual({ ok: true });
    expect(readDraftFromContext(session.getContext()).pipeline.stages.length).toBe(
      1,
    );
  });

  it("invokeProfileTool returns ok:false without throwing when the stub throws", async () => {
    const profile = createWorkshopAuthorProfile({
      retriever: createStubDocsRetriever(async () => {
        throw new Error("boom");
      }),
    });
    const result = await invokeProfileTool(
      profile,
      "retrieve_docs",
      { query: "envelopes" },
      emptyToolContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/boom/);
  });

  it("filesystem retriever returns public doc excerpts when available", async () => {
    const retriever = createFilesystemDocsRetriever();
    const result = await retriever.retrieve("ask_operator hitl gate", {
      kind: "docs",
      limit: 3,
    });
    expect(result.ok).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.some((h) => h.path.includes("hitl"))).toBe(true);
    expect(result.hits[0]!.excerpt.length).toBeGreaterThan(20);
  });
});

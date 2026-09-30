import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkshopOperatorHost,
  emptyDraftPackage,
  proposeStageFromUserMessage,
  type OperatorAgentModel,
} from "../src/operatorAgent/index.js";
import {
  chunkAssistantText,
  iterateWorkshopChatStreamFrames,
  resetWorkshopChatSessionsForTests,
  runWorkshopChatTurn,
  WorkshopChatSessionRegistry,
  WorkshopSessionStoreError,
} from "../src/workshop/chatTurn.js";
import { DEFAULT_WORKSHOP_MODEL } from "../src/workshop/modelSettings.js";
import {
  createWorkshopSession,
  getWorkshopSession,
  resolveWorkshopSessionStoreRoot,
} from "../src/workshop/sessionStore.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

afterEach(() => {
  resetWorkshopChatSessionsForTests();
});

describe("runWorkshopChatTurn", () => {
  it("runs Workshop Author on the fake Operator Agent Host (not AgentPort)", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      const created = createWorkshopSession(storeRoot, { id: "sess-1" });
      const host = createWorkshopOperatorHost([{ type: "propose_stage" }]);
      const registry = new WorkshopChatSessionRegistry(host);
      const draft = emptyDraftPackage("demo");
      const result = await runWorkshopChatTurn({
        sessionId: created.id,
        draft,
        message: "intake form review",
        host,
        registry,
        storeRoot,
        model: "openai/gpt-5",
        settingsDefault: "anthropic/claude-sonnet-4-5",
      });

      expect(result.sessionId).toBe("sess-1");
      expect(result.model).toBe("openai/gpt-5");
      expect(result.pending).not.toBeNull();
      expect(result.pending!.summary).toMatch(/Add stage/i);
      expect(result.pending!.nextDraft.pipeline.stages.length).toBe(1);
      expect(result.draft.pipeline.stages.length).toBe(1);
      expect(result.events.some((e) => e.type === "message")).toBe(true);
      expect(result.events.some((e) => e.type === "proposal")).toBe(true);
    });
  });

  it("respects settings default when session model is absent", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "sess-echo" });
      const host = createWorkshopOperatorHost([{ type: "echo" }]);
      const registry = new WorkshopChatSessionRegistry(host);
      const result = await runWorkshopChatTurn({
        sessionId: "sess-echo",
        draft: emptyDraftPackage("demo"),
        message: "hello",
        host,
        registry,
        storeRoot,
        settingsDefault: "openai/gpt-5",
      });
      expect(result.model).toBe("openai/gpt-5");
      expect(result.events).toEqual([
        { type: "message", role: "assistant", text: "Got it: hello" },
      ]);
    });
  });

  it("falls back to DEFAULT_WORKSHOP_MODEL", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "sess-default" });
      const host = createWorkshopOperatorHost([{ type: "echo" }]);
      const registry = new WorkshopChatSessionRegistry(host);
      const result = await runWorkshopChatTurn({
        sessionId: "sess-default",
        draft: emptyDraftPackage("demo"),
        message: "ping",
        host,
        registry,
        storeRoot,
      });
      expect(result.model).toBe(DEFAULT_WORKSHOP_MODEL);
    });
  });

  it("applies mutations immediately and returns an undo pending card", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "sess-mutate" });
      const host = createWorkshopOperatorHost([{ type: "propose_stage" }]);
      const registry = new WorkshopChatSessionRegistry(host);
      const result = await runWorkshopChatTurn({
        sessionId: "sess-mutate",
        draft: emptyDraftPackage("demo"),
        message: "intake form review",
        host,
        registry,
        storeRoot,
      });
      expect(result.autoApply).toBe(false);
      expect(result.draft.pipeline.stages.length).toBe(1);
      expect(result.pending).not.toBeNull();
      expect(result.pending!.nextDraft.pipeline.stages.length).toBe(1);
      expect(result.events.some((e) => e.type === "proposal")).toBe(true);
    });
  });

  it("reuses the same host session across two turns with the same sessionId", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "sess-multi" });
      const host = createWorkshopOperatorHost([
        { type: "propose_stage" },
        { type: "echo" },
      ]);
      const registry = new WorkshopChatSessionRegistry(host);

      const first = await runWorkshopChatTurn({
        sessionId: "sess-multi",
        draft: emptyDraftPackage("demo"),
        message: "intake form review",
        host,
        registry,
        storeRoot,
      });
      expect(first.draft.pipeline.stages.length).toBe(1);
      expect(registry.has("sess-multi")).toBe(true);
      const live = registry.get("sess-multi");
      expect(live).toBeDefined();

      const second = await runWorkshopChatTurn({
        sessionId: "sess-multi",
        draft: first.draft,
        message: "continue",
        host,
        registry,
        storeRoot,
      });
      expect(registry.get("sess-multi")).toBe(live);
      expect(second.events).toEqual([
        { type: "message", role: "assistant", text: "Got it: continue" },
      ]);
      // Host session retained prior mutation context; draft rebound from client.
      expect(second.draft.pipeline.stages.length).toBe(1);

      const stored = getWorkshopSession(storeRoot, "sess-multi");
      expect(stored.title).toBe("intake form review");
      expect(stored.transcript.filter((m) => m.role === "user")).toHaveLength(
        2,
      );
      expect(
        stored.transcript.filter((m) => m.role === "assistant").length,
      ).toBeGreaterThanOrEqual(2);
    });
  });

  it("rejects unknown sessionId without create-on-missing", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      const host = createWorkshopOperatorHost([{ type: "echo" }]);
      const registry = new WorkshopChatSessionRegistry(host);
      await expect(
        runWorkshopChatTurn({
          sessionId: "missing",
          draft: emptyDraftPackage("demo"),
          message: "hello",
          host,
          registry,
          storeRoot,
        }),
      ).rejects.toBeInstanceOf(WorkshopSessionStoreError);
      expect(registry.has("missing")).toBe(false);
    });
  });

  it("rebinds the client-posted draft each turn", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "sess-rebind" });
      const host = createWorkshopOperatorHost([
        { type: "propose_stage" },
        { type: "echo" },
      ]);
      const registry = new WorkshopChatSessionRegistry(host);

      await runWorkshopChatTurn({
        sessionId: "sess-rebind",
        draft: emptyDraftPackage("demo"),
        message: "intake form review",
        host,
        registry,
        storeRoot,
      });

      const clientDraft = emptyDraftPackage("client-owned");
      clientDraft.pipeline.stages = [
        { id: "from-client", name: "From client", prompt: "x" },
      ];
      const second = await runWorkshopChatTurn({
        sessionId: "sess-rebind",
        draft: clientDraft,
        message: "ping",
        host,
        registry,
        storeRoot,
      });
      expect(second.draft.pipeline.id).toBe("client-owned");
      expect(second.draft.pipeline.stages.map((s) => s.id)).toEqual([
        "from-client",
      ]);
    });
  });
});

describe("workshop chat stream frames", () => {
  it("characterization: post-hoc path chunks assistant text only after a completed turn", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "sess-stream" });
      const host = createWorkshopOperatorHost([{ type: "echo" }]);
      const registry = new WorkshopChatSessionRegistry(host);
      const result = await runWorkshopChatTurn({
        sessionId: "sess-stream",
        draft: emptyDraftPackage("demo"),
        message: "hello world",
        host,
        registry,
        storeRoot,
      });
      // Baseline: iterateWorkshopChatStreamFrames only runs on a finished turn.
      expect(result.events.some((e) => e.type === "message")).toBe(true);
      const frames = [...iterateWorkshopChatStreamFrames(result)];
      const deltas = frames.filter((f) => f.type === "delta");
      expect(deltas.length).toBeGreaterThanOrEqual(1);
      expect(frames.some((f) => f.type === "event")).toBe(true);
      const done = frames.find((f) => f.type === "done");
      expect(done?.type).toBe("done");
      if (done?.type === "done") {
        expect(done.sessionId).toBe("sess-stream");
        expect(done.model).toBe(DEFAULT_WORKSHOP_MODEL);
        expect(done.draft.pipeline.id).toBe("demo");
      }
      // Chunk size stays ~28 chars for post-hoc progressive feel.
      const long = "x".repeat(60);
      expect(chunkAssistantText(long, 28)).toEqual([
        "x".repeat(28),
        "x".repeat(28),
        "x".repeat(4),
      ]);
    });
  });

  it("forwards mid-turn onDelta callbacks before the turn resolves", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "sess-mid-delta" });
      const deltas: string[] = [];
      let completeResolved = false;
      const model: OperatorAgentModel = {
        async complete({ onDelta }) {
          onDelta?.("Hel");
          await new Promise((r) => setTimeout(r, 15));
          expect(completeResolved).toBe(false);
          onDelta?.("lo!");
          await new Promise((r) => setTimeout(r, 15));
          return {
            events: [
              { type: "message", role: "assistant", text: "Hello!" },
            ],
          };
        },
      };
      const host = createWorkshopOperatorHost({ model });
      const registry = new WorkshopChatSessionRegistry(host);
      const resultPromise = runWorkshopChatTurn({
        sessionId: "sess-mid-delta",
        draft: emptyDraftPackage("demo"),
        message: "hi",
        host,
        registry,
        storeRoot,
        onDelta: (text) => {
          expect(completeResolved).toBe(false);
          deltas.push(text);
        },
      });
      const result = await resultPromise;
      completeResolved = true;
      expect(deltas).toEqual(["Hel", "lo!"]);
      expect(result.events).toEqual([
        { type: "message", role: "assistant", text: "Hello!" },
      ]);
    });
  });

  it("tool-only / empty-text turn yields events without inventing Done.", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "sess-tool-only" });
      const deltas: string[] = [];
      const model: OperatorAgentModel = {
        async complete({ tools }) {
          proposeStageFromUserMessage(tools, "intake form");
          return { events: [] };
        },
      };
      const host = createWorkshopOperatorHost({ model });
      const registry = new WorkshopChatSessionRegistry(host);
      const result = await runWorkshopChatTurn({
        sessionId: "sess-tool-only",
        draft: emptyDraftPackage("demo"),
        message: "intake form",
        host,
        registry,
        storeRoot,
        onDelta: (text) => deltas.push(text),
      });
      expect(deltas).toEqual([]);
      expect(result.events.some((e) => e.type === "proposal")).toBe(true);
      expect(
        result.events.some(
          (e) =>
            e.type === "message" &&
            typeof e.text === "string" &&
            e.text === "Done.",
        ),
      ).toBe(false);
      const frames = [...iterateWorkshopChatStreamFrames(result)];
      expect(frames.some((f) => f.type === "delta")).toBe(false);
      expect(frames.at(-1)?.type).toBe("done");
    });
  });

  it("chunkAssistantText splits deterministically", () => {
    expect(chunkAssistantText("abcdefgh", 3)).toEqual([
      "abc",
      "def",
      "gh",
    ]);
    expect(chunkAssistantText("")).toEqual([]);
  });
});

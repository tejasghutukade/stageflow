import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDraftPackage, type DraftPackage } from "../src/config/draftPackage.js";
import {
  createWorkshopOperatorHost,
  emptyDraftPackage,
  invokeProfileTool,
  proposeStageFromUserMessage,
  readDraftFromContext,
  type OperatorAgentModel,
} from "../src/operatorAgent/index.js";
import {
  chunkAssistantText,
  focusWorkshopBuildPointer,
  iterateWorkshopChatStreamFrames,
  pinWorkshopBuildOnCreate,
  resetWorkshopChatSessionsForTests,
  runWorkshopChatTurn,
  stopWorkshopChatTurn,
  undoWorkshopSessionMutation,
  WorkshopChatSessionRegistry,
  WorkshopSessionStoreError,
} from "../src/workshop/chatTurn.js";
import { DEFAULT_WORKSHOP_MODEL } from "../src/workshop/modelSettings.js";
import {
  createWorkshopBuild,
  getWorkshopBuild,
  listWorkshopBuilds,
} from "../src/workshop/buildStore.js";
import {
  createWorkshopSession,
  getWorkshopSession,
  resolveWorkshopSessionStoreRoot,
  updateWorkshopSessionActiveBuildId,
} from "../src/workshop/sessionStore.js";
import {
  initTempGitRepo,
  withIsolatedHome,
} from "./helpers/projectContext.js";

const SAVE_MODEL = "anthropic/claude-sonnet-4-5";
const SAVE_IO = {
  io: {
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
  },
};

function savableDraft(id: string, prompt = "Clarify"): DraftPackage {
  return {
    pipeline: {
      id,
      stages: [{ id: "clarify", uses: "./clarify.yaml", entry: true }],
    },
    stages: [
      {
        path: "./clarify.yaml",
        body: {
          id: "clarify",
          system_prompt: prompt,
          model: SAVE_MODEL,
          ...SAVE_IO,
        },
      },
    ],
  };
}

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

  it("rejects mid-stream undo without rebinding a stale draft", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "sess-inflight-undo" });
      let releaseSend!: () => void;
      const sendGate = new Promise<void>((resolve) => {
        releaseSend = resolve;
      });
      let markEntered!: () => void;
      const enteredSend = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const model: OperatorAgentModel = {
        async complete({ tools }) {
          proposeStageFromUserMessage(tools, "intake form review");
          markEntered();
          await sendGate;
          return {
            events: [
              { type: "message", role: "assistant", text: "working" },
            ],
          };
        },
      };
      const host = createWorkshopOperatorHost({ model });
      const registry = new WorkshopChatSessionRegistry(host);
      const liveDraft = emptyDraftPackage("live-host");
      liveDraft.pipeline.stages = [
        { id: "live-stage", name: "Live", prompt: "keep" },
      ];

      const turnPromise = runWorkshopChatTurn({
        sessionId: "sess-inflight-undo",
        draft: liveDraft,
        message: "intake form review",
        host,
        registry,
        storeRoot,
      });

      await enteredSend;
      expect(registry.isTurnInFlight("sess-inflight-undo")).toBe(true);

      const staleDraft = emptyDraftPackage("stale-client");
      staleDraft.pipeline.stages = [
        { id: "stale", name: "Stale", prompt: "wipe" },
      ];
      const undo = await undoWorkshopSessionMutation({
        sessionId: "sess-inflight-undo",
        draft: staleDraft,
        host,
        registry,
        storeRoot,
      });

      expect(undo.ok).toBe(false);
      if (undo.ok) throw new Error("expected conflict");
      expect(undo.reason).toBe("conflict");
      expect(undo.notice).toMatch(/in progress/i);
      expect(undo.draft.pipeline.id).not.toBe("stale-client");

      const hostDraft = readDraftFromContext(
        registry.get("sess-inflight-undo")!.getContext(),
      );
      expect(hostDraft.pipeline.id).not.toBe("stale-client");
      expect(hostDraft.pipeline.stages.map((s) => s.id)).not.toContain("stale");

      releaseSend();
      await turnPromise;
      expect(registry.isTurnInFlight("sess-inflight-undo")).toBe(false);
    });
  });

  it("abortTurn interrupts the in-flight prompt", async () => {
      await withIsolatedHome(async () => {
        const storeRoot = resolveWorkshopSessionStoreRoot();
        createWorkshopSession(storeRoot, { id: "sess-abort" });
        let releaseSend!: () => void;
        const sendGate = new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
        let markEntered!: () => void;
        const enteredSend = new Promise<void>((resolve) => {
          markEntered = resolve;
        });
        let aborted = false;
        const model: OperatorAgentModel = {
          async complete() {
            markEntered();
            await sendGate;
            return {
              events: [
                { type: "message", role: "assistant", text: "stopped" },
              ],
            };
          },
          async abort() {
            aborted = true;
            releaseSend();
          },
        };
        const host = createWorkshopOperatorHost({ model });
        const registry = new WorkshopChatSessionRegistry(host);
        const turnPromise = runWorkshopChatTurn({
          sessionId: "sess-abort",
          draft: emptyDraftPackage("demo"),
          message: "stop this",
          host,
          registry,
          storeRoot,
        });

        await enteredSend;
        expect(await registry.abortTurn("sess-abort")).toBe(true);
        expect(aborted).toBe(true);
        const result = await turnPromise;
        expect(registry.isTurnInFlight("sess-abort")).toBe(false);
        expect(result.events).toEqual([
          { type: "message", role: "assistant", text: "stopped" },
        ]);
        expect(await registry.abortTurn("sess-abort")).toBe(false);
      });
    });

  it("an unlinked session's edit tool returns an error and does not create a build", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "sess-unlinked-edit" });
      const host = createWorkshopOperatorHost([
        {
          type: "call_tool",
          name: "edit_pipeline",
          args: { id: "sneaky" },
        },
      ]);
      const registry = new WorkshopChatSessionRegistry(host);
      const result = await runWorkshopChatTurn({
        sessionId: "sess-unlinked-edit",
        draft: emptyDraftPackage("posted"),
        message: "rename it",
        host,
        registry,
        storeRoot,
      });
      const tool = result.events.find((event) => event.type === "tool_result");
      expect(tool?.type).toBe("tool_result");
      if (tool?.type !== "tool_result") return;
      expect(tool.name).toBe("edit_pipeline");
      expect(tool.result.ok).toBe(false);
      expect(tool.result.error).toMatch(/no build is selected/i);
      expect(listWorkshopBuilds(storeRoot)).toEqual([]);
      expect(getWorkshopSession(storeRoot, "sess-unlinked-edit").activeBuildId).toBeUndefined();
      expect(result.draft.pipeline.id).toBe("posted");
    });
  });

  it("a focus during an in-flight turn keeps the host on A and the pointer on B", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "sess-focus-inflight" });
      createWorkshopBuild(storeRoot, {
        id: "build-a",
        draft: emptyDraftPackage("alpha"),
      });
      createWorkshopBuild(storeRoot, {
        id: "build-b",
        draft: emptyDraftPackage("beta"),
      });
      updateWorkshopSessionActiveBuildId(storeRoot, "sess-focus-inflight", "build-a");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const pointerFrames: string[] = [];
      const model: OperatorAgentModel = {
        async complete({ tools }) {
          proposeStageFromUserMessage(tools, "intake form review");
          markEntered();
          await gate;
          return {
            events: [
              { type: "message", role: "assistant", text: "still on a" },
            ],
          };
        },
      };
      const host = createWorkshopOperatorHost({ model });
      const registry = new WorkshopChatSessionRegistry(host);
      const turnPromise = runWorkshopChatTurn({
        sessionId: "sess-focus-inflight",
        draft: emptyDraftPackage("posted"),
        message: "intake form review",
        host,
        registry,
        storeRoot,
        onPointerChange: (frame) => {
          pointerFrames.push(frame.buildId);
        },
      });
      await entered;
      const hostDuring = readDraftFromContext(
        registry.get("sess-focus-inflight")!.getContext(),
      );
      expect(hostDuring.pipeline.id).toBe("alpha");
      const focus = focusWorkshopBuildPointer({
        sessionId: "sess-focus-inflight",
        buildId: "build-b",
        registry,
        storeRoot,
      });
      expect(focus.pinMoved).toBe(false);
      const hostAfterFocus = readDraftFromContext(
        registry.get("sess-focus-inflight")!.getContext(),
      );
      expect(hostAfterFocus.pipeline.id).toBe("alpha");
      expect(hostAfterFocus.pipeline.stages.length).toBe(1);
      release();
      const result = await turnPromise;
      expect(result.buildId).toBe("build-a");
      expect(result.draft.pipeline.id).toBe("alpha");
      expect(pointerFrames).toEqual(["build-b"]);
      expect(getWorkshopSession(storeRoot, "sess-focus-inflight").activeBuildId).toBe(
        "build-b",
      );
      expect(getWorkshopBuild(storeRoot, "build-a").draft.pipeline.id).toBe("alpha");
      expect(getWorkshopBuild(storeRoot, "build-a").draft.pipeline.stages.length).toBe(1);
      expect(getWorkshopBuild(storeRoot, "build-b").draft.pipeline.id).toBe("beta");
      expect(getWorkshopBuild(storeRoot, "build-b").draft.pipeline.stages).toEqual([]);
    });
  });

  it("stop names the pinned build id", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "sess-stop-pin" });
      createWorkshopBuild(storeRoot, {
        id: "build-stop",
        draft: emptyDraftPackage("alpha"),
      });
      updateWorkshopSessionActiveBuildId(storeRoot, "sess-stop-pin", "build-stop");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markEntered!: () => void;
      const entered = new Promise<void>((resolve) => {
        markEntered = resolve;
      });
      const model: OperatorAgentModel = {
        async complete() {
          markEntered();
          await gate;
          return {
            events: [
              { type: "message", role: "assistant", text: "stopped" },
            ],
          };
        },
        async abort() {
          release();
        },
      };
      const host = createWorkshopOperatorHost({ model });
      const registry = new WorkshopChatSessionRegistry(host);
      const turnPromise = runWorkshopChatTurn({
        sessionId: "sess-stop-pin",
        draft: emptyDraftPackage("posted"),
        message: "stop",
        host,
        registry,
        storeRoot,
      });
      await entered;
      const stopped = await stopWorkshopChatTurn(registry, "sess-stop-pin");
      expect(stopped.stopped).toBe(true);
      expect(stopped.buildId).toBe("build-stop");
      expect(stopped.draft?.pipeline.id).toBe("alpha");
      await turnPromise;
    });
  });

  it("save on a tied build writes the stored path and keeps the id", async () => {
    const repo = await initTempGitRepo();
    try {
      await withIsolatedHome(async () => {
        const storeRoot = resolveWorkshopSessionStoreRoot();
        await mkdir(path.join(repo.root, "pipelines"), { recursive: true });
        const original = savableDraft("tied-pipe", "on disk");
        const createdFile = await createDraftPackage(repo.root, {
          directory: "pipelines",
          draft: original,
          pipelineFilename: "tied-pipe.pipeline.yaml",
        });
        expect(createdFile.ok).toBe(true);
        createWorkshopSession(storeRoot, { id: "sess-tied-save" });
        const edited = savableDraft("tied-pipe", "from the pinned build");
        createWorkshopBuild(storeRoot, {
          id: "build-tied",
          draft: edited,
          projectRoot: repo.root,
          relativePath: "pipelines/tied-pipe.pipeline.yaml",
        });
        updateWorkshopSessionActiveBuildId(
          storeRoot,
          "sess-tied-save",
          "build-tied",
        );
        const host = createWorkshopOperatorHost({
          projectRoot: repo.root,
          script: [
            {
              type: "call_tool",
              name: "save",
              args: {
                directory: "elsewhere",
                pipelineFilename: "nope.pipeline.yaml",
                mode: "overwrite",
              },
            },
          ],
        });
        const registry = new WorkshopChatSessionRegistry(host);
        const result = await runWorkshopChatTurn({
          sessionId: "sess-tied-save",
          draft: emptyDraftPackage("posted"),
          message: "save it",
          host,
          registry,
          storeRoot,
        });
        const tool = result.events.find((event) => event.type === "tool_result");
        expect(tool?.type).toBe("tool_result");
        if (tool?.type !== "tool_result") return;
        expect(tool.result.ok).toBe(true);
        const yaml = await readFile(
          path.join(repo.root, "pipelines", "clarify.yaml"),
          "utf8",
        );
        expect(yaml).toContain("from the pinned build");
        const pipelineYaml = await readFile(
          path.join(repo.root, "pipelines", "tied-pipe.pipeline.yaml"),
          "utf8",
        );
        expect(pipelineYaml).toContain("tied-pipe");
        await expect(
          readFile(
            path.join(repo.root, "elsewhere", "nope.pipeline.yaml"),
            "utf8",
          ),
        ).rejects.toThrow();
        const stored = getWorkshopBuild(storeRoot, "build-tied");
        expect(stored.id).toBe("build-tied");
        expect(stored.projectRoot).toBe(repo.root);
        expect(stored.relativePath).toBe("pipelines/tied-pipe.pipeline.yaml");
      });
    } finally {
      await repo.cleanup();
    }
  });

  it("save on an untitled build with no operator destination fails and stays untitled", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "sess-untitled-save" });
      createWorkshopBuild(storeRoot, {
        id: "build-untitled",
        draft: savableDraft("untitled-pipe"),
      });
      updateWorkshopSessionActiveBuildId(
        storeRoot,
        "sess-untitled-save",
        "build-untitled",
      );
      const host = createWorkshopOperatorHost([
        { type: "call_tool", name: "save", args: {} },
      ]);
      const registry = new WorkshopChatSessionRegistry(host);
      const result = await runWorkshopChatTurn({
        sessionId: "sess-untitled-save",
        draft: emptyDraftPackage("posted"),
        message: "save somewhere",
        host,
        registry,
        storeRoot,
      });
      const tool = result.events.find((event) => event.type === "tool_result");
      expect(tool?.type).toBe("tool_result");
      if (tool?.type !== "tool_result") return;
      expect(tool.result.ok).toBe(false);
      const stored = getWorkshopBuild(storeRoot, "build-untitled");
      expect(stored.id).toBe("build-untitled");
      expect(stored.projectRoot).toBeNull();
      expect(stored.relativePath).toBeNull();
    });
  });

  it("a successful save of an untitled build records that destination on the same id", async () => {
    const repo = await initTempGitRepo();
    try {
      await withIsolatedHome(async () => {
        const storeRoot = resolveWorkshopSessionStoreRoot();
        await mkdir(path.join(repo.root, "pipelines"), { recursive: true });
        createWorkshopSession(storeRoot, { id: "sess-save-dest" });
        createWorkshopBuild(storeRoot, {
          id: "build-save",
          draft: savableDraft("saved-new"),
        });
        updateWorkshopSessionActiveBuildId(storeRoot, "sess-save-dest", "build-save");
        const host = createWorkshopOperatorHost({
          projectRoot: repo.root,
          script: [
            {
              type: "call_tool",
              name: "save",
              args: { directory: "pipelines", mode: "create" },
            },
          ],
        });
        const registry = new WorkshopChatSessionRegistry(host);
        const result = await runWorkshopChatTurn({
          sessionId: "sess-save-dest",
          draft: emptyDraftPackage("posted"),
          message: "save to pipelines",
          host,
          registry,
          storeRoot,
        });
        const tool = result.events.find((event) => event.type === "tool_result");
        expect(tool?.type).toBe("tool_result");
        if (tool?.type !== "tool_result") return;
        expect(tool.result.ok).toBe(true);
        const stored = getWorkshopBuild(storeRoot, "build-save");
        expect(stored.id).toBe("build-save");
        expect(stored.projectRoot).toBe(path.resolve(repo.root));
        expect(stored.relativePath).toBe("pipelines/saved-new.pipeline.yaml");
        const yaml = await readFile(
          path.join(repo.root, "pipelines", "saved-new.pipeline.yaml"),
          "utf8",
        );
        expect(yaml).toContain("saved-new");
      });
    } finally {
      await repo.cleanup();
    }
  });

  it("after a create on an unlinked turn, a later edit persists on the new build", async () => {
    await withIsolatedHome(async () => {
      const storeRoot = resolveWorkshopSessionStoreRoot();
      createWorkshopSession(storeRoot, { id: "sess-create" });
      const pointerFrames: Array<{ buildId: string; draftId: string }> = [];
      const model: OperatorAgentModel = {
        async complete({ tools, profile }) {
          const build = pinWorkshopBuildOnCreate({
            sessionId: "sess-create",
            draft: emptyDraftPackage("fresh"),
            registry,
            storeRoot,
          });
          expect(build.projectRoot).toBeNull();
          expect(build.relativePath).toBeNull();
          await invokeProfileTool(profile, "edit_pipeline", { id: "renamed" }, tools);
          return {
            events: [
              { type: "message", role: "assistant", text: "created" },
            ],
          };
        },
      };
      const host = createWorkshopOperatorHost({ model });
      const registry = new WorkshopChatSessionRegistry(host);
      const result = await runWorkshopChatTurn({
        sessionId: "sess-create",
        draft: emptyDraftPackage("posted"),
        message: "build me a pipeline",
        host,
        registry,
        storeRoot,
        onPointerChange: (frame) => {
          pointerFrames.push({
            buildId: frame.buildId,
            draftId: frame.draft.pipeline.id,
          });
        },
      });
      expect(pointerFrames).toEqual([
        { buildId: result.buildId, draftId: "fresh" },
      ]);
      expect(result.buildId).toBeTruthy();
      expect(result.draft.pipeline.id).toBe("renamed");
      const stored = getWorkshopBuild(storeRoot, result.buildId!);
      expect(stored.id).toBe(result.buildId);
      expect(stored.draft.pipeline.id).toBe("renamed");
      expect(stored.projectRoot).toBeNull();
      expect(getWorkshopSession(storeRoot, "sess-create").activeBuildId).toBe(
        result.buildId,
      );
      expect(listWorkshopBuilds(storeRoot)).toHaveLength(1);
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
        async complete({ onDelta, modelId }) {
          expect(modelId).toBe(DEFAULT_WORKSHOP_MODEL);
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

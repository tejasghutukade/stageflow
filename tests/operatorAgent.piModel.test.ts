import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLiveWorkshopOperatorHost,
  sessionNeedsExtensionReload,
  workshopToolActivity,
  workshopToolLogFields,
  type PiOperatorOpenSessionInput,
  type PiOperatorSessionHandle,
} from "../src/operatorAgent/piModel.js";
import {
  createWorkshopDraftContext,
  emptyDraftPackage,
  readDraftFromContext,
  WORKSHOP_AUTHOR_PROFILE_ID,
} from "../src/operatorAgent/index.js";
import { resolveWorkshopToolNames } from "../src/agent/piSessionFactory.js";
import { WORKSHOP_AUTHOR_TOOL_NAMES } from "../src/operatorAgent/profiles/workshopAuthor.js";

const tempHandles: PiOperatorSessionHandle[] = [];

afterEach(async () => {
  while (tempHandles.length > 0) {
    const handle = tempHandles.pop();
    if (handle) await handle.shutdown();
  }
});

function createMockPiHandle(
  onPrompt?: (text: string, input: PiOperatorOpenSessionInput) => Promise<void> | void,
): {
  handle: PiOperatorSessionHandle;
  getOpened: () => PiOperatorOpenSessionInput | undefined;
  openPiSession: (
    input: PiOperatorOpenSessionInput,
  ) => Promise<PiOperatorSessionHandle>;
} {
  let opened: PiOperatorOpenSessionInput | undefined;
  const listeners = new Set<(event: unknown) => void>();
  const appendCustomMessageEntry = vi.fn();
  const handle: PiOperatorSessionHandle = {
    session: {
      prompt: vi.fn(async (text: string) => {
        if (opened) await onPrompt?.(text, opened);
        for (const listener of listeners) {
          listener({
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              delta: "Done.",
            },
          });
          listener({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Done." }],
            },
          });
        }
      }),
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      dispose: vi.fn(),
      bindExtensions: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      setThinkingLevel: vi.fn(),
      agent: { state: { messages: [] } },
    },
    sessionManager: {
      appendCustomMessageEntry,
      buildSessionContext: vi.fn(() => ({ messages: [] })),
      getSessionId: vi.fn(() => "pi-mock-session"),
    },
    piSessionId: "pi-mock-session",
    shutdown: vi.fn(async () => undefined),
  };
  tempHandles.push(handle);
  return {
    handle,
    getOpened: () => opened,
    openPiSession: async (input) => {
      opened = input;
      return handle;
    },
  };
}

describe("createPiOperatorAgentModel", () => {
  it("mocked Pi tool call mutates the draft via host handlers", async () => {
    const mock = createMockPiHandle(async (_text, input) => {
      expect(input.toolNames).toEqual(
        resolveWorkshopToolNames([...WORKSHOP_AUTHOR_TOOL_NAMES]),
      );
      expect(input.toolNames).not.toContain("bash");
      expect(input.toolNames).not.toContain("write");
      expect(input.toolNames).not.toContain("edit");
      const createStage = input.customTools.find((t) => t.name === "create_stage");
      expect(createStage).toBeDefined();
      await createStage!.execute!("call-1", {
        id: "intake",
        system_prompt: "Collect intake",
        summary: "intake form",
      });
    });

    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      openPiSession: mock.openPiSession,
      resolveModelId: () => "anthropic/claude-sonnet-4-5",
    });

    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    const events = await session.send("add intake stage");
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    expect(events.some((e) => e.type === "proposal")).toBe(true);
    expect(events.some((e) => e.type === "message")).toBe(true);

    const draft = readDraftFromContext(session.getContext());
    expect(draft.pipeline.stages.map((s) => s.id)).toEqual(["intake"]);
    expect(mock.getOpened()?.systemPrompt.length).toBeGreaterThan(0);

    session.close();
  });

  it("opens Pi on the composer model and switches it before a later turn", async () => {
    const applied: string[] = [];
    const mock = createMockPiHandle();
    mock.handle.applyModel = vi.fn(async (modelId: string) => {
      applied.push(modelId);
    });
    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      openPiSession: mock.openPiSession,
      resolveModelId: () => "anthropic/claude-sonnet-4-5",
    });
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    await session.send("first", { modelId: "cursor/auto" });
    expect(mock.getOpened()?.modelId).toBe("cursor/auto");
    expect(applied).toEqual([]);

    await session.send("second", { modelId: "cursor/composer-2-5" });
    expect(applied).toEqual(["cursor/composer-2-5"]);

    session.close();
  });

  it("replay path seeds transcript without throwing", async () => {
    const mock = createMockPiHandle();
    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      openPiSession: mock.openPiSession,
      resolveModelId: () => "anthropic/claude-sonnet-4-5",
    });

    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    await expect(
      session.prepareRestart?.([
        { role: "user", text: "Build a release pipeline" },
        { role: "assistant", text: "What stages do you need?" },
      ]),
    ).resolves.toBeUndefined();

    expect(
      mock.handle.sessionManager.appendCustomMessageEntry,
    ).toHaveBeenCalledWith(
      "stageflow.workshop_transcript_replay",
      expect.stringContaining("Build a release pipeline"),
      true,
      { messageCount: 2 },
    );

    session.close();
  });

  it("forwards Pi text_delta to onDelta mid-prompt before complete resolves", async () => {
    const deltas: string[] = [];
    let promptFinished = false;
    const listeners = new Set<(event: unknown) => void>();
    const multiHandle: PiOperatorSessionHandle = {
      session: {
        prompt: vi.fn(async () => {
          for (const listener of listeners) {
            listener({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "Hi " },
            });
          }
          await new Promise((r) => setTimeout(r, 10));
          expect(promptFinished).toBe(false);
          for (const listener of listeners) {
            listener({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: "there" },
            });
          }
          for (const listener of listeners) {
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Hi there" }],
              },
            });
          }
          promptFinished = true;
        }),
        subscribe: vi.fn((listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
        dispose: vi.fn(),
        bindExtensions: vi.fn(async () => undefined),
        setModel: vi.fn(async () => undefined),
        setThinkingLevel: vi.fn(),
        agent: { state: { messages: [] } },
      },
      sessionManager: {
        appendCustomMessageEntry: vi.fn(),
        buildSessionContext: vi.fn(() => ({ messages: [] })),
        getSessionId: vi.fn(() => "pi-stream-session"),
      },
      piSessionId: "pi-stream-session",
      shutdown: vi.fn(async () => undefined),
    };
    tempHandles.push(multiHandle);

    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      openPiSession: async () => multiHandle,
      resolveModelId: () => "anthropic/claude-sonnet-4-5",
    });
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    const events = await session.send("hello", {
      onDelta: (text) => {
        expect(promptFinished).toBe(false);
        deltas.push(text);
      },
    });
    expect(deltas).toEqual(["Hi ", "there"]);
    expect(events.some((e) => e.type === "message")).toBe(true);
    const msg = events.find((e) => e.type === "message");
    if (msg?.type === "message") {
      expect(msg.text).toBe("Hi there");
    }
    session.close();
  });

  it("abort calls the Pi session abort while a prompt is in flight", async () => {
    let releasePrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    let promptStarted!: () => void;
    const promptEntered = new Promise<void>((resolve) => {
      promptStarted = resolve;
    });
    const listeners = new Set<(event: unknown) => void>();
    const abort = vi.fn(async () => {
      releasePrompt();
    });
    const handle: PiOperatorSessionHandle = {
      session: {
        prompt: vi.fn(async () => {
          promptStarted();
          await promptGate;
          for (const listener of listeners) {
            listener({
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Stopped." }],
              },
            });
          }
        }),
        abort,
        subscribe: vi.fn((listener: (event: unknown) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        }),
        dispose: vi.fn(),
        bindExtensions: vi.fn(async () => undefined),
        setModel: vi.fn(async () => undefined),
        setThinkingLevel: vi.fn(),
        agent: { state: { messages: [] } },
      },
      sessionManager: {
        appendCustomMessageEntry: vi.fn(),
        buildSessionContext: vi.fn(() => ({ messages: [] })),
        getSessionId: vi.fn(() => "pi-abort-session"),
      },
      piSessionId: "pi-abort-session",
      shutdown: vi.fn(async () => undefined),
    };
    tempHandles.push(handle);

    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      openPiSession: async () => handle,
      resolveModelId: () => "anthropic/claude-sonnet-4-5",
    });
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });
    const sendPromise = session.send("hello");
    await promptEntered;
    await session.abort();
    const events = await sendPromise;
    expect(abort).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "message")).toBe(true);
    session.close();
  });

  it("missing auth surfaces a clear actionable error", async () => {
    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      authPath: "/tmp/stageflow-missing-workshop-auth.json",
      resolveModelId: () => "anthropic/claude-sonnet-4-5",
    });

    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    const events = await session.send("hello");
    const error = events.find((e) => e.type === "error");
    expect(error?.type).toBe("error");
    if (error?.type === "error") {
      expect(error.message).toMatch(/provider auth is not configured/i);
      expect(error.message).toMatch(/sf providers/i);
    }

    session.close();
  });

  it("concurrent chat turns keep profile/tools/events isolated per binding", async () => {
    let openSeq = 0;
    const openPiSession = async (
      input: PiOperatorOpenSessionInput,
    ): Promise<PiOperatorSessionHandle> => {
      openSeq += 1;
      const openIndex = openSeq;
      const listeners = new Set<(event: unknown) => void>();
      const handle: PiOperatorSessionHandle = {
        session: {
          prompt: vi.fn(async () => {
            await new Promise((r) => setTimeout(r, 20));
            const createStage = input.customTools.find(
              (t) => t.name === "create_stage",
            );
            expect(createStage).toBeDefined();
            await createStage!.execute!("call-1", {
              id: `stage-${openIndex}`,
              summary: `from open ${openIndex}`,
            });
            for (const listener of listeners) {
              listener({
                type: "message_update",
                assistantMessageEvent: {
                  type: "text_delta",
                  delta: "ok",
                },
              });
              listener({
                type: "message_end",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: "ok" }],
                },
              });
            }
          }),
          subscribe: vi.fn((listener: (event: unknown) => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          }),
          dispose: vi.fn(),
          bindExtensions: vi.fn(async () => undefined),
          setModel: vi.fn(async () => undefined),
          setThinkingLevel: vi.fn(),
          agent: { state: { messages: [] } },
        },
        sessionManager: {
          appendCustomMessageEntry: vi.fn(),
          buildSessionContext: vi.fn(() => ({ messages: [] })),
          getSessionId: vi.fn(() => `pi-${openIndex}`),
        },
        piSessionId: `pi-${openIndex}`,
        shutdown: vi.fn(async () => undefined),
      };
      tempHandles.push(handle);
      return handle;
    };

    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      openPiSession,
      resolveModelId: () => "anthropic/claude-sonnet-4-5",
    });

    const sessionA = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("alpha")),
    });
    const sessionB = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("beta")),
    });

    const [eventsA, eventsB] = await Promise.all([
      sessionA.send("mutate A"),
      sessionB.send("mutate B"),
    ]);

    expect(eventsA.some((e) => e.type === "tool_result")).toBe(true);
    expect(eventsB.some((e) => e.type === "tool_result")).toBe(true);

    const draftA = readDraftFromContext(sessionA.getContext());
    const draftB = readDraftFromContext(sessionB.getContext());
    expect(draftA.pipeline.id).toBe("alpha");
    expect(draftB.pipeline.id).toBe("beta");
    expect(draftA.pipeline.stages).toHaveLength(1);
    expect(draftB.pipeline.stages).toHaveLength(1);
    expect(draftA.pipeline.stages[0]!.id).not.toBe(draftB.pipeline.stages[0]!.id);
    expect(draftA.stages).toHaveLength(1);
    expect(draftB.stages).toHaveLength(1);

    sessionA.close();
    sessionB.close();
  });

  it("appends the cursor pi__ tool hint only for cursor models", async () => {
    let prompted = "";
    const mock = createMockPiHandle(async (text) => {
      prompted = text;
    });
    const host = createLiveWorkshopOperatorHost({
      cwd: process.cwd(),
      openPiSession: mock.openPiSession,
      resolveModelId: () => "anthropic/claude-sonnet-4-5",
    });
    const session = host.openSession({
      profileId: WORKSHOP_AUTHOR_PROFILE_ID,
      context: createWorkshopDraftContext(emptyDraftPackage("demo")),
    });

    await session.send("make a research stage", { modelId: "cursor/auto" });
    expect(prompted).toContain("make a research stage");
    expect(prompted).toContain("pi__create_stage");
    expect(mock.getOpened()?.modelId).toBe("cursor/auto");

    await session.send("make a research stage", {
      modelId: "anthropic/claude-sonnet-4-5",
    });
    expect(prompted).toBe("make a research stage");
    session.close();
  });

  it("logs a string stage body as ignored; successful tools stay complete", () => {
    const args = { id: "research", body: "system_prompt: hello" };
    expect(workshopToolLogFields(args).bodyIgnored).toBe(true);
    expect(workshopToolLogFields(args).bodyType).toBe("string");
    expect(
      workshopToolActivity("call-1", "create_stage", "done", args, {
        ok: true,
        content: null,
      }),
    ).toMatchObject({
      id: "call-1",
      name: "create_stage",
      status: "complete",
      target: "research",
    });
    expect(
      workshopToolActivity("call-2", "create_stage", "done", { id: "research" }, {
        ok: false,
        content: null,
        error: "id is required",
      }),
    ).toMatchObject({
      status: "error",
      errorMessage: "id is required",
    });
  });

  it("reopens a Pi session when the selected model needs an extension that is not loaded", () => {
    expect(sessionNeedsExtensionReload(undefined, ["/ext/index.js"])).toBe(false);
    expect(sessionNeedsExtensionReload([], ["/ext/index.js"])).toBe(true);
    expect(sessionNeedsExtensionReload(["/ext/index.js"], ["/ext/index.js"])).toBe(false);
    expect(sessionNeedsExtensionReload(["/ext/index.js"], [])).toBe(false);
  });
});

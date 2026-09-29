import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLiveWorkshopOperatorHost,
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
});

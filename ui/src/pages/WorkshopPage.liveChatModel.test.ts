import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    sendWorkshopChatTurnStreaming: vi.fn(),
    stopWorkshopChat: vi.fn(),
  };
});

import {
  sendWorkshopChatTurnStreaming,
  stopWorkshopChat,
  type DraftPackagePayload,
  type WorkshopChatProposalPayload,
} from "../api";
import {
  composerModelFromSettings,
  createLiveChatModel,
  type LiveChatRefs,
} from "./WorkshopPage";

function refOf<T>(value: T): MutableRefObject<T> {
  return { current: value };
}

describe("workshop open model", () => {
  it("uses defaultModel", () => {
    expect(composerModelFromSettings("openai/gpt-5")).toBe("openai/gpt-5");
    expect(composerModelFromSettings("  openai/gpt-5  ")).toBe("openai/gpt-5");
  });

  it("shows cursor/auto when defaultModel is missing or blank", () => {
    expect(composerModelFromSettings(undefined)).toBe("cursor/auto");
    expect(composerModelFromSettings(null)).toBe("cursor/auto");
    expect(composerModelFromSettings("")).toBe("cursor/auto");
    expect(composerModelFromSettings("   ")).toBe("cursor/auto");
  });
});

describe("createLiveChatModel model posting", () => {
  beforeEach(() => {
    vi.mocked(sendWorkshopChatTurnStreaming).mockReset();
  });

  it("posts the LiveChatRefs.model value on send", async () => {
    const draft: DraftPackagePayload = {
      pipeline: { id: "untitled", stages: [] },
    };
    const proposals: WorkshopChatProposalPayload[] = [];
    const refs: LiveChatRefs = {
      sessionId: refOf<string | null>("sess-1"),
      draft: refOf(draft),
      model: refOf("openrouter/tencent/hy3"),
      selectedBuildId: refOf<string | null>(null),
      setDraft: vi.fn(),
      registerMutations: vi.fn((next) => {
        proposals.push(...next);
      }),
      pushActivity: vi.fn(),
      clearActivity: vi.fn(),
      stop: { current: null },
    };

    vi.mocked(sendWorkshopChatTurnStreaming).mockResolvedValue({
      ok: true,
      sessionId: "sess-1",
      events: [{ type: "message", role: "assistant", text: "ok" }],
      draft,
      pending: null,
      autoApply: false,
      model: "openrouter/tencent/hy3",
    });

    const adapter = createLiveChatModel(refs);
    const run = adapter.run({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    } as never);

    const parts: unknown[] = [];
    if (Symbol.asyncIterator in Object(run)) {
      for await (const chunk of run as AsyncGenerator<unknown>) {
        parts.push(chunk);
      }
    } else {
      parts.push(await run);
    }

    expect(sendWorkshopChatTurnStreaming).toHaveBeenCalledTimes(1);
    expect(sendWorkshopChatTurnStreaming).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "sess-1",
        message: "hello",
        model: "openrouter/tencent/hy3",
      }),
      expect.any(Object),
    );
    expect(parts.length).toBeGreaterThan(0);
  });

  it("stop interrupts the stream and keeps the composer reply", async () => {
    const draft: DraftPackagePayload = {
      pipeline: { id: "untitled", stages: [] },
    };
    const refs: LiveChatRefs = {
      sessionId: refOf<string | null>("sess-1"),
      draft: refOf(draft),
      model: refOf("cursor/auto"),
      selectedBuildId: refOf<string | null>(null),
      setDraft: vi.fn(),
      registerMutations: vi.fn(),
      pushActivity: vi.fn(),
      clearActivity: vi.fn(),
      stop: { current: null },
    };

    vi.mocked(sendWorkshopChatTurnStreaming).mockImplementation(
      (_input, handlers) =>
        new Promise((resolve) => {
          const finish = () =>
            resolve({
              ok: false,
              status: 0,
              error: "Stopped.",
            });
          if (handlers?.signal?.aborted) finish();
          else handlers?.signal?.addEventListener("abort", finish, { once: true });
        }),
    );
    vi.mocked(stopWorkshopChat).mockResolvedValue({
      draft,
      pending: null,
    });

    const adapter = createLiveChatModel(refs);
    const run = adapter.run({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "build a pipeline" }],
        },
      ],
    } as never);

    const iterator = run as AsyncGenerator<{
      content: Array<{ type: string; text?: string }>;
    }>;
    const first = iterator.next();
    for (let i = 0; i < 20 && !refs.stop.current; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(refs.stop.current).toEqual(expect.any(Function));
    refs.stop.current?.();
    const stopped = await first;
    expect(stopped.done).toBe(false);
    expect(stopped.value?.content[0]?.text).toBe("Stopped.");
    expect(stopWorkshopChat).toHaveBeenCalledWith("sess-1");
    expect((await iterator.next()).done).toBe(true);
  });
});

const selectedDraft: DraftPackagePayload = {
  pipeline: { id: "selected", stages: [{ id: "on-screen" }] },
};

const otherDraft: DraftPackagePayload = {
  pipeline: { id: "other", stages: [{ id: "late" }] },
};

function liveRefs(
  selectedBuildId: string | null,
  setDraft: (draft: DraftPackagePayload) => void,
): LiveChatRefs {
  return {
    sessionId: refOf<string | null>("sess-1"),
    draft: refOf(selectedDraft),
    model: refOf("cursor/auto"),
    selectedBuildId: refOf(selectedBuildId),
    setDraft,
    registerMutations: vi.fn(),
    pushActivity: vi.fn(),
    clearActivity: vi.fn(),
    stop: { current: null },
  };
}

async function drainRun(
  refs: LiveChatRefs,
  message = "edit the pipeline",
): Promise<void> {
  const adapter = createLiveChatModel(refs);
  const run = adapter.run({
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: message }],
      },
    ],
  } as never);
  if (Symbol.asyncIterator in Object(run)) {
    for await (const _chunk of run as AsyncGenerator<unknown>) {
      /* drain */
    }
  } else {
    await run;
  }
}

describe("createLiveChatModel studio drafts", () => {
  beforeEach(() => {
    vi.mocked(sendWorkshopChatTurnStreaming).mockReset();
    vi.mocked(stopWorkshopChat).mockReset();
  });

  it("an activity draft whose build id is not the selected id does not replace the studio draft", async () => {
    const setDraft = vi.fn();
    const refs = liveRefs("build-selected", setDraft);
    vi.mocked(sendWorkshopChatTurnStreaming).mockImplementation(
      async (_input, handlers) => {
        handlers?.onActivity?.({
          id: "tool-1",
          name: "edit_stage",
          status: "complete",
          buildId: "build-other",
          draft: otherDraft,
        });
        return {
          ok: true,
          sessionId: "sess-1",
          events: [],
          draft: selectedDraft,
          pending: null,
          autoApply: false,
          model: "cursor/auto",
          buildId: "build-selected",
        };
      },
    );

    await drainRun(refs);

    expect(setDraft).not.toHaveBeenCalledWith(otherDraft);
  });

  it("a done draft whose build id is no longer selected does not replace the studio draft", async () => {
    const setDraft = vi.fn();
    const refs = liveRefs("build-selected", setDraft);
    vi.mocked(sendWorkshopChatTurnStreaming).mockResolvedValue({
      ok: true,
      sessionId: "sess-1",
      events: [{ type: "message", role: "assistant", text: "done" }],
      draft: otherDraft,
      pending: null,
      autoApply: false,
      model: "cursor/auto",
      buildId: "build-other",
    });

    await drainRun(refs);

    expect(setDraft).not.toHaveBeenCalled();
  });

  it("a stop draft for a build id that is no longer selected does not replace the studio draft", async () => {
    const setDraft = vi.fn();
    const refs = liveRefs("build-selected", setDraft);
    vi.mocked(sendWorkshopChatTurnStreaming).mockImplementation(
      (_input, handlers) =>
        new Promise((resolve) => {
          const finish = () =>
            resolve({
              ok: false,
              status: 0,
              error: "Stopped.",
            });
          if (handlers?.signal?.aborted) finish();
          else handlers?.signal?.addEventListener("abort", finish, { once: true });
        }),
    );
    vi.mocked(stopWorkshopChat).mockResolvedValue({
      draft: otherDraft,
      pending: null,
      buildId: "build-other",
    });

    const adapter = createLiveChatModel(refs);
    const run = adapter.run({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "build a pipeline" }],
        },
      ],
    } as never);
    const iterator = run as AsyncGenerator<unknown>;
    const first = iterator.next();
    for (let i = 0; i < 20 && !refs.stop.current; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    refs.stop.current?.();
    await first;
    await iterator.next();

    expect(setDraft).not.toHaveBeenCalled();
  });

  it("a pointer-change frame for a new build selects it and shows its draft", async () => {
    const setDraft = vi.fn();
    const refs = liveRefs("build-old", setDraft);
    const created: DraftPackagePayload = {
      pipeline: { id: "created", stages: [{ id: "fresh" }] },
    };
    vi.mocked(sendWorkshopChatTurnStreaming).mockImplementation(
      async (_input, handlers) => {
        handlers?.onPointerChange?.({
          buildId: "build-new",
          draft: created,
        });
        handlers?.onActivity?.({
          id: "tool-late",
          name: "edit_stage",
          status: "complete",
          buildId: "build-old",
          draft: otherDraft,
        });
        return {
          ok: true,
          sessionId: "sess-1",
          events: [{ type: "message", role: "assistant", text: "created" }],
          draft: otherDraft,
          pending: null,
          autoApply: false,
          model: "cursor/auto",
          buildId: "build-old",
        };
      },
    );

    await drainRun(refs);

    expect(refs.selectedBuildId.current).toBe("build-new");
    expect(setDraft).toHaveBeenCalledWith(created);
    expect(setDraft).not.toHaveBeenCalledWith(otherDraft);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    sendWorkshopChatTurnStreaming: vi.fn(),
  };
});

import {
  sendWorkshopChatTurnStreaming,
  type DraftPackagePayload,
  type WorkshopChatProposalPayload,
} from "../api";
import { createLiveChatModel, type LiveChatRefs } from "./WorkshopPage";

function refOf<T>(value: T): MutableRefObject<T> {
  return { current: value };
}

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
      setDraft: vi.fn(),
      registerMutations: vi.fn((next) => {
        proposals.push(...next);
      }),
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
});

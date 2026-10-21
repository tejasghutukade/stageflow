import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";

vi.mock("../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../api")>();
  return {
    ...actual,
    sendWorkshopChatTurnStreaming: vi.fn(),
    stopWorkshopChat: vi.fn(),
  };
});

import { sendWorkshopChatTurnStreaming, type DraftPackagePayload } from "../../../api";
import { createLiveChatModel, type LiveChatRefs } from "../../../pages/WorkshopPage";
import { userMessageCustom } from "./attachments";

function refOf<T>(value: T): MutableRefObject<T> {
  return { current: value };
}

const draft: DraftPackagePayload = { pipeline: { id: "untitled", stages: [] } };

function baseRefs(extra: Partial<LiveChatRefs> = {}): LiveChatRefs {
  return {
    sessionId: refOf<string | null>("sess-1"),
    draft: refOf(draft),
    model: refOf("cursor/auto"),
    selectedBuildId: refOf<string | null>(null),
    setDraft: vi.fn(),
    registerMutations: vi.fn(),
    pushActivity: vi.fn(),
    clearActivity: vi.fn(),
    stop: { current: null },
    ...extra,
  };
}

async function drain(refs: LiveChatRefs, custom?: Record<string, unknown>) {
  const run = createLiveChatModel(refs).run({
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
        ...(custom ? { metadata: { custom } } : {}),
      },
    ],
  } as never);
  for await (const _chunk of run as AsyncGenerator<unknown>) {
    void _chunk;
  }
  return vi.mocked(sendWorkshopChatTurnStreaming).mock.calls[0]![0] as Record<string, unknown>;
}

describe("createLiveChatModel turn body", () => {
  beforeEach(() => {
    vi.mocked(sendWorkshopChatTurnStreaming).mockReset();
    vi.mocked(sendWorkshopChatTurnStreaming).mockResolvedValue({
      ok: true,
      sessionId: "sess-1",
      events: [{ type: "message", role: "assistant", text: "ok" }],
      draft,
      pending: null,
      autoApply: false,
      model: "cursor/auto",
    });
  });

  it("sends autoApply false and omits attachments and context by default", async () => {
    const body = await drain(baseRefs());
    expect(body.autoApply).toBe(false);
    expect("attachments" in body).toBe(false);
    expect("context" in body).toBe(false);
  });

  it("forwards attachments and @docs carried on the user message", async () => {
    const attachment = { name: "notes.md", mediaType: "text/markdown", size: 5, content: "hello" };
    const body = await drain(
      baseRefs({ autoApply: refOf(true) }),
      userMessageCustom([attachment], true),
    );
    expect(body).toMatchObject({
      autoApply: true,
      attachments: [attachment],
      context: { docs: true },
    });
  });

  it("falls back to the attachment and docs refs", async () => {
    const attachment = { name: "a.txt", mediaType: "text/plain", size: 1, content: "a" };
    const body = await drain(
      baseRefs({ attachments: refOf([attachment]), docsContext: refOf(true) }),
    );
    expect(body).toMatchObject({ attachments: [attachment], context: { docs: true } });
  });
});

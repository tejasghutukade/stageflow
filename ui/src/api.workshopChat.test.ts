import { afterEach, describe, expect, it, vi } from "vitest";
import { sendWorkshopChatTurnStreaming } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function ndjsonResponse(lines: string[]): Response {
  const body = lines.map((line) => `${line}\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}

describe("sendWorkshopChatTurnStreaming", () => {
  it("returns ok:false on error event without done and does not JSON-fallback", async () => {
    const fetchMock = vi.fn(async () =>
      ndjsonResponse([
        JSON.stringify({ type: "delta", text: "partial" }),
        JSON.stringify({
          type: "event",
          event: { type: "error", message: "model exploded mid-turn" },
        }),
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendWorkshopChatTurnStreaming({
      sessionId: "sess-1",
      message: "boom",
      draft: { pipeline: { id: "demo", stages: [] } },
    });

    expect(result).toEqual({
      ok: false,
      status: 200,
      error: "model exploded mid-turn",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("delivers pointer-change before a later activity and keeps done buildId", async () => {
    const created = { pipeline: { id: "created", stages: [{ id: "fresh" }] } };
    const late = { pipeline: { id: "late", stages: [{ id: "old" }] } };
    const order: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ndjsonResponse([
          JSON.stringify({
            type: "pointer-change",
            buildId: "build-new",
            draft: created,
          }),
          JSON.stringify({
            type: "activity",
            id: "tool-1",
            name: "edit_stage",
            status: "complete",
            buildId: "build-old",
            draft: late,
          }),
          JSON.stringify({
            type: "done",
            sessionId: "sess-1",
            events: [],
            draft: late,
            pending: null,
            autoApply: false,
            model: "cursor/auto",
            buildId: "build-old",
          }),
        ]),
      ),
    );

    const result = await sendWorkshopChatTurnStreaming(
      {
        sessionId: "sess-1",
        message: "build",
        draft: { pipeline: { id: "untitled", stages: [] } },
      },
      {
        onPointerChange: (frame) => {
          order.push(`pointer:${frame.buildId}`);
        },
        onActivity: (update) => {
          order.push(`activity:${update.buildId ?? ""}`);
        },
      },
    );

    expect(order).toEqual(["pointer:build-new", "activity:build-old"]);
    expect(result).toMatchObject({
      ok: true,
      buildId: "build-old",
      draft: late,
    });
  });
});

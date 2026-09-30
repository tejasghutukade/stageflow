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
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mcpCall } from "./mcpCall.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubSse(content: Array<Record<string, unknown>>, status = 200) {
  const body = `data: ${JSON.stringify({ result: { content } })}\n\n`;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status })),
  );
}

describe("mcpCall", () => {
  it("does not JSON.parse image data as payload", async () => {
    stubSse([
      { type: "image", mimeType: "image/png", data: '{"hijack":true}' },
      { type: "text", text: '{"ok":true}' },
    ]);
    const result = await mcpCall("http://127.0.0.1:9", "read_artifact");
    expect(result.payload).toEqual({ ok: true });
    expect(result.payload).not.toEqual({ hijack: true });
    expect(result.content[0]?.type).toBe("image");
  });

  it("leaves payload null when only image blocks are present", async () => {
    stubSse([{ type: "image", mimeType: "image/png", data: '{"hijack":true}' }]);
    const result = await mcpCall("http://127.0.0.1:9", "read_artifact");
    expect(result.payload).toBeNull();
  });
});

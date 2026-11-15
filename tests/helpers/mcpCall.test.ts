import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_TOOLSETS_ALL_QUERY, mcpCall, mcpUrl } from "./mcpCall.js";

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
  it("requests the full tool surface by default", async () => {
    stubSse([{ type: "text", text: '{"ok":true}' }]);
    await mcpCall("http://127.0.0.1:9", "get_eval");
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      mcpUrl("http://127.0.0.1:9", MCP_TOOLSETS_ALL_QUERY),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("opts.query empty string hits bare /mcp for core-only callers", async () => {
    stubSse([{ type: "text", text: '{"ok":true}' }]);
    await mcpCall("http://127.0.0.1:9", "get_run", {}, { query: "" });
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9/mcp",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not JSON.parse image data as payload", async () => {
    stubSse([
      { type: "image", mimeType: "image/png", data: '{"hijack":true}' },
      { type: "text", text: '{"ok":true}' },
    ]);
    const result = await mcpCall("http://127.0.0.1:9", "run_files");
    expect(result.payload).toEqual({ ok: true });
    expect(result.payload).not.toEqual({ hijack: true });
    expect(result.content[0]?.type).toBe("image");
  });

  it("leaves payload null when only image blocks are present", async () => {
    stubSse([{ type: "image", mimeType: "image/png", data: '{"hijack":true}' }]);
    const result = await mcpCall("http://127.0.0.1:9", "run_files");
    expect(result.payload).toBeNull();
  });
});

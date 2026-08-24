import { describe, expect, it } from "vitest";
import {
  DEFAULT_MCP_URL,
  cursorMcpConfigJson,
  mcpEndpointUrl,
} from "./mcpConnect";

describe("mcpEndpointUrl", () => {
  it("uses the default sf ui URL during Vite hot-reload", () => {
    expect(
      mcpEndpointUrl(
        { hostname: "127.0.0.1", port: "5173", protocol: "http:" },
        { viteDev: true },
      ),
    ).toBe(DEFAULT_MCP_URL);
  });

  it("follows the console origin when this page is served by sf ui", () => {
    expect(
      mcpEndpointUrl({ hostname: "127.0.0.1", port: "3847", protocol: "http:" }),
    ).toBe("http://127.0.0.1:3847/mcp");
  });

  it("follows a custom sf ui port", () => {
    expect(
      mcpEndpointUrl({ hostname: "127.0.0.1", port: "4000", protocol: "http:" }),
    ).toBe("http://127.0.0.1:4000/mcp");
  });

  it("normalizes localhost to 127.0.0.1", () => {
    expect(
      mcpEndpointUrl({ hostname: "localhost", port: "3847", protocol: "http:" }),
    ).toBe("http://127.0.0.1:3847/mcp");
  });

  it("falls back to the default URL off loopback", () => {
    expect(
      mcpEndpointUrl({ hostname: "example.local", port: "3847", protocol: "http:" }),
    ).toBe(DEFAULT_MCP_URL);
  });
});

describe("cursorMcpConfigJson", () => {
  it("emits a Streamable HTTP Cursor entry", () => {
    expect(cursorMcpConfigJson("http://127.0.0.1:3847/mcp")).toBe(
      `{
  "mcpServers": {
    "stageflow": {
      "url": "http://127.0.0.1:3847/mcp"
    }
  }
}
`,
    );
  });
});

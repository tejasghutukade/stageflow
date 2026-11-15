import { describe, expect, it } from "vitest";
import {
  DEFAULT_MCP_URL,
  MCP_BARE_URL_NOTES,
  OPTIONAL_MCP_TOOLSET_IDS,
  cursorMcpConfigJson,
  mcpEndpointUrl,
  mcpToolsetsQuery,
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

  it("normalizes browser ::1 and bracketed [::1] to 127.0.0.1", () => {
    expect(
      mcpEndpointUrl({ hostname: "::1", port: "3847", protocol: "http:" }),
    ).toBe("http://127.0.0.1:3847/mcp");
    expect(
      mcpEndpointUrl({ hostname: "[::1]", port: "3847", protocol: "http:" }),
    ).toBe("http://127.0.0.1:3847/mcp");
  });

  it("brackets non-loopback IPv6 hostnames in the MCP origin", () => {
    expect(
      mcpEndpointUrl({ hostname: "2001:db8::1", port: "3847", protocol: "http:" }),
    ).toBe("http://[2001:db8::1]:3847/mcp");
    expect(
      mcpEndpointUrl({
        hostname: "[2001:db8::1]",
        port: "3847",
        protocol: "http:",
      }),
    ).toBe("http://[2001:db8::1]:3847/mcp");
  });

  it("derives MCP URL from non-loopback console origins", () => {
    expect(
      mcpEndpointUrl({ hostname: "build-box", port: "3847", protocol: "http:" }),
    ).toBe("http://build-box:3847/mcp");
    expect(
      mcpEndpointUrl({ hostname: "example.local", port: "3847", protocol: "http:" }),
    ).toBe("http://example.local:3847/mcp");
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

  it("carries the same URL when toolsets are selected", () => {
    const url = "http://127.0.0.1:3847/mcp?toolsets=agents,evals";
    expect(cursorMcpConfigJson(url)).toContain(url);
  });
});

describe("mcpToolsetsQuery", () => {
  it("omits the query when no optional toolsets are chosen", () => {
    expect(mcpToolsetsQuery([])).toBe("");
  });

  it("adds evals and agents in stable sorted order", () => {
    expect(mcpToolsetsQuery(["evals", "agents"])).toBe("?toolsets=agents,evals");
  });

  it("uses all when every optional toolset is selected", () => {
    expect(mcpToolsetsQuery([...OPTIONAL_MCP_TOOLSET_IDS])).toBe("?toolsets=all");
  });

  it("ignores core in the selection", () => {
    expect(mcpToolsetsQuery(["core", "evals"])).toBe("?toolsets=evals");
  });
});

describe("mcpEndpointUrl with toolsets", () => {
  it("keeps a bare path without optional toolsets", () => {
    expect(
      mcpEndpointUrl({ hostname: "127.0.0.1", port: "3847", protocol: "http:" }, { toolsets: [] }),
    ).toBe("http://127.0.0.1:3847/mcp");
  });

  it("appends the toolsets query to the derived origin", () => {
    expect(
      mcpEndpointUrl(
        { hostname: "127.0.0.1", port: "3847", protocol: "http:" },
        { toolsets: ["agents", "evals"] },
      ),
    ).toBe("http://127.0.0.1:3847/mcp?toolsets=agents,evals");
  });

  it("appends toolsets on the default Vite dev URL", () => {
    expect(
      mcpEndpointUrl(
        { hostname: "127.0.0.1", port: "5173", protocol: "http:" },
        { viteDev: true, toolsets: ["evals"] },
      ),
    ).toBe(`${DEFAULT_MCP_URL}?toolsets=evals`);
  });
});

describe("MCP panel copy", () => {
  it("reminds operators that bare URLs are core-only and sessions need reconnect", () => {
    expect(MCP_BARE_URL_NOTES).toMatch(/core tools/i);
    expect(MCP_BARE_URL_NOTES).toMatch(/reconnect/i);
  });
});

describe("hosted MCP address", () => {
  const browser = { hostname: "127.0.0.1", port: "3847", protocol: "http:" };

  it("uses the Host's public address instead of the browser's", () => {
    expect(mcpEndpointUrl(browser, { publicOrigin: "https://acme.stage-flow.dev/" })).toBe("https://acme.stage-flow.dev/mcp");
    expect(mcpEndpointUrl(browser, { publicOrigin: "https://acme.stage-flow.dev", toolsets: ["agents"] })).toBe(
      "https://acme.stage-flow.dev/mcp?toolsets=agents",
    );
  });

  it("falls back to the browser's address with no public address", () => {
    expect(mcpEndpointUrl(browser, { publicOrigin: null })).toBe("http://127.0.0.1:3847/mcp");
  });

  it("puts an Authorization header in the client config for a hosted workspace", () => {
    const config = JSON.parse(cursorMcpConfigJson("https://acme.stage-flow.dev/mcp", { apiKeyHeader: true }));
    expect(config.mcpServers.stageflow).toEqual({
      url: "https://acme.stage-flow.dev/mcp",
      headers: { Authorization: "Bearer YOUR_DRIVE_API_KEY" },
    });
  });
});

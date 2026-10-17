import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { grantNameForMcpTool, listCachedMcpTools } from "../src/config/mcpToolCache.js";

describe("mcp tool cache", () => {
  it("names grants the way the runtime strips them", () => {
    expect(grantNameForMcpTool("github", "list_issues")).toBe("list_issues");
    expect(grantNameForMcpTool("github", "github_list_issues")).toBe("list_issues");
    expect(grantNameForMcpTool("docs", "search.pages")).toBe("search_pages");
    expect(grantNameForMcpTool("docs", "docs_")).toBe("docs_");
  });

  it("reads one server's tools, sorted, and ignores missing or broken caches", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sf-tool-cache-"));
    expect(listCachedMcpTools("a", dir)).toBeUndefined();
    writeFileSync(
      path.join(dir, "mcp-cache.json"),
      JSON.stringify({
        version: 1,
        servers: {
          a: { cachedAt: 5, tools: [{ name: "zeta" }, { name: "alpha", description: "First" }, { nope: 1 }] },
          b: { tools: [] },
        },
      }),
    );
    expect(listCachedMcpTools("a", dir)).toEqual({
      cachedAt: 5,
      tools: [{ name: "alpha", description: "First" }, { name: "zeta" }],
    });
    expect(listCachedMcpTools("b", dir)?.tools).toEqual([]);
    expect(listCachedMcpTools("c", dir)).toBeUndefined();
    writeFileSync(path.join(dir, "mcp-cache.json"), "{ broken");
    expect(listCachedMcpTools("a", dir)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { STAGEFLOW_MCP_SERVER_NAME } from "../src/agent/claudeTools.js";
import {
  StageMcpError,
  assertMcpAllowlistKnown,
  loadMcpCatalog,
  mcpCatalogPath,
  parseMcpCatalog,
  type ResolvedMcpServerConfig,
  type ResolvedMcpServers,
} from "../src/config/resolveStageMcpServers.js";
import type { StageConfig } from "../src/types/stage.js";

const STAGE_MCP_ERROR_CODES = [
  "missing_catalog",
  "unknown_server",
  "reserved_name",
  "unresolved_var",
  "invalid_config",
  "connect_failed",
] as const;

describe("StageMcpError", () => {
  it.each(STAGE_MCP_ERROR_CODES)(
    "constructs with name StageMcpError and code %s",
    (code) => {
      const error = new StageMcpError(`stage mcp: ${code}`, code);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(StageMcpError);
      expect(error.name).toBe("StageMcpError");
      expect(error.code).toBe(code);
      expect(error.message).toBe(`stage mcp: ${code}`);
    },
  );
});

describe("stage MCP snapshot types", () => {
  it("accepts StageConfig.mcp as a string list and keeps skill valid", () => {
    const stage: StageConfig = {
      id: "implement",
      system_prompt: "Implement the change",
      model: "anthropic/claude-sonnet-4-5",
      skill: "ship",
      mcp: ["github"],
    };
    expect(stage.mcp).toEqual(["github"]);
    expect(stage.skill).toBe("ship");
  });

  it("imports ResolvedMcpServerConfig and ResolvedMcpServers", () => {
    const github: ResolvedMcpServerConfig = {
      type: "http",
      url: "https://api.github.com/mcp",
    };
    const resolved: ResolvedMcpServers = { github };
    expect(resolved.github).toEqual(github);
    expect(Object.keys(resolved)).toEqual(["github"]);
  });
});

describe("MCP catalog reader", () => {
  it("joins projectRoot with .mcp.json", () => {
    expect(mcpCatalogPath("/tmp/project")).toBe(path.join("/tmp/project", ".mcp.json"));
  });

  it("throws missing_catalog when the file is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-cat-missing-"));
    await expect(loadMcpCatalog(root)).rejects.toMatchObject({
      name: "StageMcpError",
      code: "missing_catalog",
    });
  });

  it("throws invalid_config for invalid JSON", () => {
    expect(() => parseMcpCatalog("{ not json", ".mcp.json")).toThrow(StageMcpError);
    try {
      parseMcpCatalog("{ not json", ".mcp.json");
    } catch (err) {
      expect(err).toBeInstanceOf(StageMcpError);
      expect((err as StageMcpError).code).toBe("invalid_config");
    }
  });

  it("throws invalid_config when mcpServers is an array", () => {
    expect(() =>
      parseMcpCatalog(JSON.stringify({ mcpServers: [] }), ".mcp.json"),
    ).toThrow(StageMcpError);
    try {
      parseMcpCatalog(JSON.stringify({ mcpServers: [] }), ".mcp.json");
    } catch (err) {
      expect((err as StageMcpError).code).toBe("invalid_config");
    }
  });

  it("throws invalid_config when mcpServers is missing or a server entry is not an object", () => {
    expect(() => parseMcpCatalog(JSON.stringify({}), ".mcp.json")).toThrow(StageMcpError);
    try {
      parseMcpCatalog(JSON.stringify({}), ".mcp.json");
    } catch (err) {
      expect((err as StageMcpError).code).toBe("invalid_config");
      expect((err as StageMcpError).message).toMatch(/mcpServers/);
    }
    try {
      parseMcpCatalog(JSON.stringify({ mcpServers: { github: "npx" } }), ".mcp.json");
    } catch (err) {
      expect((err as StageMcpError).code).toBe("invalid_config");
      expect((err as StageMcpError).message).toContain("github");
    }
  });

  it("throws reserved_name when a catalog key is stageflow", () => {
    try {
      parseMcpCatalog(
        JSON.stringify({ mcpServers: { [STAGEFLOW_MCP_SERVER_NAME]: { command: "npx" } } }),
        ".mcp.json",
      );
      expect.fail("expected StageMcpError");
    } catch (err) {
      expect(err).toBeInstanceOf(StageMcpError);
      expect((err as StageMcpError).code).toBe("reserved_name");
      expect((err as StageMcpError).message).toContain(STAGEFLOW_MCP_SERVER_NAME);
    }
  });

  it("returns plain-object entries without interpolating env tokens", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-cat-ok-"));
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: {
            type: "http",
            url: "${API_BASE_URL:-https://api.example.com}/mcp",
            headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
          },
        },
      }),
    );
    const catalog = await loadMcpCatalog(root);
    expect(catalog.path).toBe(mcpCatalogPath(root));
    expect(catalog.servers.github).toEqual({
      type: "http",
      url: "${API_BASE_URL:-https://api.example.com}/mcp",
      headers: { Authorization: "Bearer ${GITHUB_TOKEN}" },
    });
  });

  it("throws unknown_server when an allowlist name is absent", () => {
    try {
      assertMcpAllowlistKnown({ github: { command: "npx" } }, ["notion"]);
      expect.fail("expected StageMcpError");
    } catch (err) {
      expect(err).toBeInstanceOf(StageMcpError);
      expect((err as StageMcpError).code).toBe("unknown_server");
      expect((err as StageMcpError).message).toContain("notion");
    }
  });

  it("accepts allowlist names that exist as catalog keys", () => {
    expect(() =>
      assertMcpAllowlistKnown({ github: { command: "npx" } }, ["github"]),
    ).not.toThrow();
  });
});

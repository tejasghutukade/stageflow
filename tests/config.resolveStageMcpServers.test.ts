import { describe, expect, it } from "vitest";
import {
  StageMcpError,
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

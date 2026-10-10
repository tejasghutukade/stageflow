import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentAdapter, resolveStageToolNames } from "../src/agent/piAdapter.js";
import type { StageRunInput } from "../src/agent/port.js";
import {
  bindPiAgentDirEnv,
  buildStageRoots,
} from "../src/runtime/stageRoots.js";
import { withIsolatedHome } from "./helpers/projectContext.js";

const captured = vi.hoisted(() => ({
  tools: [] as string[][],
  sessions: [] as AgentSession[],
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: async (
      options: Parameters<typeof actual.createAgentSession>[0],
    ) => {
      captured.tools.push([...(options?.tools ?? [])]);
      const result = await actual.createAgentSession(options);
      captured.sessions.push(result.session);
      result.session.prompt = async () => {};
      return result;
    },
  };
});

const ECHO_SERVER = path.resolve("examples/stage-mcp/echo-mcp.mjs");

describe("stage MCP with the real pi-mcp-adapter", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    captured.tools.length = 0;
    captured.sessions.length = 0;
    for (const dir of cleanup.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exposes the declared direct tools on a cold metadata cache, without mcpScript or the mcp gateway", async () => {
    await withIsolatedHome(async () => {
      const runWs = await mkdtemp(path.join(tmpdir(), "sf-pi-real-mcp-"));
      cleanup.push(runWs);
      const roots = buildStageRoots(runWs, "clarify");
      const unbind = bindPiAgentDirEnv(roots.agentDir);
      try {
        const input: StageRunInput = {
          roots,
          stage: {
            id: "clarify",
            system_prompt: "x",
            model: "anthropic/claude-sonnet-4-5",
          },
          task: { id: "t", goal: "g" },
          priorEnvelope: null,
          resolvedMcpServers: {
            echo: { command: process.execPath, args: [ECHO_SERVER], cwd: process.cwd() },
          },
        };
        expect(existsSync(path.join(roots.agentDir, "mcp-cache.json"))).toBe(false);

        await new PiAgentAdapter().runStage(input);

        expect(captured.tools).toHaveLength(1);
        expect(captured.tools[0]).toEqual([
          ...resolveStageToolNames("emit_stage_envelope", "write_stage_artifact"),
          "echo_echo",
        ]);
        const active = captured.sessions[0]!.getActiveToolNames();
        expect(active).toContain("echo_echo");
        expect(active).not.toContain("mcp");
        expect(active).not.toContain("mcpScript");
        expect(existsSync(path.join(roots.agentDir, "mcp-cache.json"))).toBe(true);
      } finally {
        unbind();
      }
    });
  }, 60_000);
});

import { describe, expect, it, vi } from "vitest";

type MockToolDef = {
  name: string;
  handler: (args: unknown, extra: unknown) => Promise<{ content: unknown[]; isError?: boolean }>;
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (
    name: string,
    _description: string,
    _inputSchema: unknown,
    handler: MockToolDef["handler"],
  ): MockToolDef => ({ name, handler }),
  createSdkMcpServer: (opts: { name: string; tools: MockToolDef[] }) => ({
    type: "sdk",
    name: opts.name,
    instance: { tools: opts.tools },
  }),
}));

function baseServerOptions() {
  return {
    capture: {},
    writeStageArtifact: { runWorkspaceDir: "/tmp/ws", stageId: "review", attempt: 1 },
  };
}

function toolsOf(server: unknown): MockToolDef[] {
  return (server as { instance: { tools: MockToolDef[] } }).instance.tools;
}

describe("buildStageflowMcpServer — sandbox_bash conditional registration", () => {
  it("does not register sandbox_bash when sandboxBash option is absent", async () => {
    const { buildStageflowMcpServer } = await import("../src/agent/claudeTools.js");
    const server = buildStageflowMcpServer(baseServerOptions());
    const names = toolsOf(server).map((t) => t.name);
    expect(names).not.toContain("sandbox_bash");
  });

  it("registers sandbox_bash when sandboxBash option is present", async () => {
    const { buildStageflowMcpServer } = await import("../src/agent/claudeTools.js");
    const server = buildStageflowMcpServer({
      ...baseServerOptions(),
      sandboxBash: { containerName: "stageflow-run-1-implement-1-abc" },
    });
    const names = toolsOf(server).map((t) => t.name);
    expect(names).toContain("sandbox_bash");
  });
});

describe("sandbox_bash tool execute", () => {
  it("calls the injected exec function with the container name and command, and formats stdout/stderr/exit code", async () => {
    const { buildStageflowMcpServer } = await import("../src/agent/claudeTools.js");
    const execute = vi.fn().mockResolvedValue({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
    });
    const server = buildStageflowMcpServer({
      ...baseServerOptions(),
      sandboxBash: { containerName: "my-container", execute },
    });
    const tool = toolsOf(server).find((t) => t.name === "sandbox_bash");
    if (!tool) throw new Error("sandbox_bash not registered");

    const result = await tool.handler({ command: "echo hello" }, {});

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ containerName: "my-container", command: "echo hello" }),
    );
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("hello");
    expect(text).toContain("Exit code: 0");
  });

  it("includes stderr in the result text when present", async () => {
    const { buildStageflowMcpServer } = await import("../src/agent/claudeTools.js");
    const execute = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "boom",
      exitCode: 1,
    });
    const server = buildStageflowMcpServer({
      ...baseServerOptions(),
      sandboxBash: { containerName: "my-container", execute },
    });
    const tool = toolsOf(server).find((t) => t.name === "sandbox_bash");
    if (!tool) throw new Error("sandbox_bash not registered");

    const result = await tool.handler({ command: "false" }, {});
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("boom");
    expect(text).toContain("Exit code: 1");
  });

  it("does not set isError on a non-zero exit code — that's a normal command result, not a tool-call failure", async () => {
    const { buildStageflowMcpServer } = await import("../src/agent/claudeTools.js");
    const execute = vi.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: 127,
    });
    const server = buildStageflowMcpServer({
      ...baseServerOptions(),
      sandboxBash: { containerName: "my-container", execute },
    });
    const tool = toolsOf(server).find((t) => t.name === "sandbox_bash");
    if (!tool) throw new Error("sandbox_bash not registered");

    const result = await tool.handler({ command: "nonexistent-cmd" }, {});
    expect(result.isError).toBeFalsy();
  });

  it("passes a caller-provided dockerBin through to the exec function", async () => {
    const { buildStageflowMcpServer } = await import("../src/agent/claudeTools.js");
    const execute = vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
    const server = buildStageflowMcpServer({
      ...baseServerOptions(),
      sandboxBash: { containerName: "my-container", dockerBin: "/fake/docker", execute },
    });
    const tool = toolsOf(server).find((t) => t.name === "sandbox_bash");
    if (!tool) throw new Error("sandbox_bash not registered");

    await tool.handler({ command: "echo hi" }, {});
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ dockerBin: "/fake/docker" }),
    );
  });

  it("sets isError when the exec function itself throws (infra failure, not a command result)", async () => {
    const { buildStageflowMcpServer } = await import("../src/agent/claudeTools.js");
    const execute = vi.fn().mockRejectedValue(new Error("failed to exec in sandbox container: spawn docker ENOENT"));
    const server = buildStageflowMcpServer({
      ...baseServerOptions(),
      sandboxBash: { containerName: "my-container", execute },
    });
    const tool = toolsOf(server).find((t) => t.name === "sandbox_bash");
    if (!tool) throw new Error("sandbox_bash not registered");

    const result = await tool.handler({ command: "echo hi" }, {});
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("ENOENT");
  });

  it("never references ANTHROPIC_API_KEY in the source module", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../src/agent/claudeTools.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("ANTHROPIC_API_KEY");
  });
});

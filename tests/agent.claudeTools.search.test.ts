import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

type MockToolDef = {
  name: string;
  description: string;
  handler: (args: unknown, extra: unknown) => Promise<{ content: unknown[]; isError?: boolean }>;
};

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (
    name: string,
    description: string,
    _inputSchema: unknown,
    handler: MockToolDef["handler"],
  ): MockToolDef => ({ name, description, handler }),
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

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

describe("Claude search tools", () => {
  it("searches and lists the stage working tree when the stage is not sandboxed", async () => {
    const { buildStageflowMcpServer } = await import("../src/agent/claudeTools.js");
    const cwd = await mkdtemp(path.join(tmpdir(), "sf-claude-search-host-"));
    let outside: string | undefined;
    try {
      await writeFile(path.join(cwd, "notes.txt"), "tree-needle\n");
      const server = buildStageflowMcpServer({
        ...baseServerOptions(),
        workspaceSearch: { cwd },
      });
      const tools = toolsOf(server);
      const names = tools.map((tool) => tool.name);
      expect(names.filter((name) => name === "grep")).toHaveLength(1);
      expect(names.filter((name) => name === "find")).toHaveLength(1);
      expect(names.filter((name) => name === "ls")).toHaveLength(1);
      expect(names).not.toContain("Grep");
      expect(names).not.toContain("Glob");

      const grep = tools.find((tool) => tool.name === "grep");
      const find = tools.find((tool) => tool.name === "find");
      const ls = tools.find((tool) => tool.name === "ls");
      if (!grep || !find || !ls) throw new Error("search tools missing");

      const grepped = await grep.handler({ pattern: "tree-needle" }, {});
      expect(grepped.isError).toBeFalsy();
      expect(textOf(grepped)).toContain("notes.txt");
      expect(textOf(grepped)).toContain("tree-needle");

      const found = await find.handler({ pattern: "*.txt" }, {});
      expect(found.isError).toBeFalsy();
      expect(textOf(found)).toContain("notes.txt");

      const listed = await ls.handler({}, {});
      expect(listed.isError).toBeFalsy();
      expect(textOf(listed)).toContain("notes.txt");

      for (const rejected of ["/etc/passwd", "~/secret", "../passwd"]) {
        const result = await grep.handler({ pattern: "root", path: rejected }, {});
        expect(result.isError).toBe(true);
        expect(textOf(result)).not.toContain("root:");
      }

      outside = await mkdtemp(path.join(tmpdir(), "sf-claude-search-outside-"));
      await writeFile(path.join(outside, "secret.txt"), "secret-needle\n");
      await symlink(outside, path.join(cwd, "linkdir"));
      const linked = await find.handler({ pattern: "*", path: "linkdir" }, {});
      expect(linked.isError).toBe(true);
      expect(textOf(linked)).toContain("path escapes the working tree");
      expect(textOf(linked)).not.toContain("secret-needle");
      const listedLink = await ls.handler({ path: "linkdir" }, {});
      expect(listedLink.isError).toBe(true);
      expect(textOf(listedLink)).not.toContain("secret.txt");

      const many = Array.from({ length: 20 }, () => "hit-line\n").join("");
      await writeFile(path.join(cwd, "many.txt"), many);
      const capped = await grep.handler({ pattern: "hit-line", path: "many.txt", limit: 2 }, {});
      expect(capped.isError).toBeFalsy();
      expect(textOf(capped).split("\n").filter((line) => line.includes("hit-line"))).toHaveLength(2);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      if (outside) await rm(outside, { recursive: true, force: true });
    }
  });

  it("runs sandboxed search in the container and does not also register host search tools", async () => {
    const { buildStageflowMcpServer } = await import("../src/agent/claudeTools.js");
    const execute = vi.fn().mockResolvedValue({
      stdout: "workspace-hit\n",
      stderr: "",
      exitCode: 0,
    });
    const server = buildStageflowMcpServer({
      ...baseServerOptions(),
      sandboxBash: {
        containerName: "my-container",
        readonlyDir: "/sandbox/inputs",
        execute,
      },
    });
    const tools = toolsOf(server);
    const names = tools.map((tool) => tool.name);
    expect(names.filter((name) => name === "grep")).toHaveLength(1);
    expect(names.filter((name) => name === "find")).toHaveLength(1);
    expect(names.filter((name) => name === "ls")).toHaveLength(1);
    expect(names).not.toContain("Grep");
    expect(names).not.toContain("Glob");

    const grep = tools.find((tool) => tool.name === "grep");
    if (!grep) throw new Error("grep not registered");
    expect(grep.description).toContain("/workspace");
    expect(grep.description).toContain("/sandbox/inputs");

    const grepped = await grep.handler({ pattern: "workspace-hit", path: "work/hello.txt" }, {});
    expect(grepped.isError).toBeFalsy();
    expect(textOf(grepped)).toContain("workspace-hit");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        containerName: "my-container",
        command: expect.stringContaining("/workspace/work/hello.txt"),
      }),
    );

    execute.mockClear();
    const outside = await grep.handler({ pattern: "root", path: "/etc/passwd" }, {});
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toMatch(/sandbox/i);
    expect(execute).not.toHaveBeenCalled();

    execute.mockResolvedValueOnce({ stdout: "mounted\n", stderr: "", exitCode: 0 });
    const mounted = await grep.handler({ pattern: "mounted", path: "/sandbox/inputs/a.txt" }, {});
    expect(mounted.isError).toBeFalsy();
    expect(textOf(mounted)).toContain("mounted");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("/sandbox/inputs/a.txt") }),
    );

    execute.mockClear();
    const sibling = await grep.handler({ pattern: "x", path: "/sandbox/other" }, {});
    expect(sibling.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});

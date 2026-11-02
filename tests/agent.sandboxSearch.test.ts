import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSandboxFindTool,
  createSandboxGrepTool,
  createSandboxLsTool,
  createSandboxReadTool,
} from "../src/agent/sandboxPiTools.js";
import { SANDBOX_MOUNT_PATH, startSandboxContainer } from "../src/runtime/sandboxContainer.js";

const fakeDockerBin = fileURLToPath(
  new URL("./fixtures/fakeSandboxDocker.mjs", import.meta.url),
);

type SearchTool = {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text?: string }>; isError?: boolean }>;
};

function textOf(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? "";
}

describe("sandbox grep, find, and ls", () => {
  const previousState = process.env.FAKE_DOCKER_STATE_DIR;

  afterEach(() => {
    if (previousState === undefined) delete process.env.FAKE_DOCKER_STATE_DIR;
    else process.env.FAKE_DOCKER_STATE_DIR = previousState;
  });

  it("searches and lists a workspace path, including a granted artifact, inside the container", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-sandbox-search-"));
    const stateDir = path.join(root, "docker-state");
    process.env.FAKE_DOCKER_STATE_DIR = stateDir;
    try {
      const { containerName } = await startSandboxContainer({
        image: "stageflow-bash:v1",
        dockerBin: fakeDockerBin,
        runId: "run-1",
        stageId: "work",
        attempt: 1,
      });
      const workspace = path.join(stateDir, containerName);
      await mkdir(path.join(workspace, "work"), { recursive: true });
      await mkdir(path.join(workspace, "grants", "review"), { recursive: true });
      await writeFile(path.join(workspace, "work", "hello.txt"), "hello-needle\n");
      await writeFile(path.join(workspace, "grants", "review", "note.txt"), "granted-needle\n");
      const target = { containerName, dockerBin: fakeDockerBin };
      const grep = createSandboxGrepTool(target) as SearchTool;
      const find = createSandboxFindTool(target) as SearchTool;
      const ls = createSandboxLsTool(target) as SearchTool;

      const grepped = await grep.execute("grep-work", { pattern: "hello-needle", path: "work" });
      expect(grepped.isError).toBeFalsy();
      expect(textOf(grepped)).toContain("hello.txt");
      expect(textOf(grepped)).toContain("hello-needle");

      const granted = await grep.execute("grep-grant", {
        pattern: "granted-needle",
        path: "grants/review/note.txt",
      });
      expect(granted.isError).toBeFalsy();
      expect(textOf(granted)).toContain("granted-needle");

      const found = await find.execute("find-work", { pattern: "*.txt", path: "work" });
      expect(found.isError).toBeFalsy();
      expect(textOf(found)).toContain("hello.txt");

      const listed = await ls.execute("ls-work", { path: "work" });
      expect(listed.isError).toBeFalsy();
      expect(textOf(listed)).toContain("hello.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a host path, a ~ path, and a .. escape before the container runs", async () => {
    const execute = vi.fn();
    const target = { containerName: "box", execute };
    const tools = [
      createSandboxGrepTool(target),
      createSandboxFindTool(target),
      createSandboxLsTool(target),
    ] as SearchTool[];
    const paths = ["/etc/passwd", "~/secret", "../etc/passwd", "work/../../etc/passwd"];
    for (const tool of tools) {
      for (const rejected of paths) {
        execute.mockClear();
        const params =
          tool === tools[2]
            ? { path: rejected }
            : { pattern: "needle", path: rejected };
        const result = await tool.execute("reject", params);
        expect(result.isError).toBe(true);
        expect(textOf(result)).toMatch(/sandbox/i);
        expect(textOf(result)).not.toContain("root:");
        expect(execute).not.toHaveBeenCalled();
      }
    }
  });

  it("searches the read-only mount and rejects every other path outside the workspace", async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: "mounted-hit\n", stderr: "", exitCode: 0 });
    const target = { containerName: "box", readonlyDir: "/sandbox/inputs", execute };
    const grep = createSandboxGrepTool(target) as SearchTool;
    const find = createSandboxFindTool(target) as SearchTool;
    const ls = createSandboxLsTool(target) as SearchTool;

    const grepped = await grep.execute("grep-ro", {
      pattern: "mounted-hit",
      path: "/sandbox/inputs/notes",
    });
    expect(grepped.isError).toBeFalsy();
    expect(textOf(grepped)).toContain("mounted-hit");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        containerName: "box",
        command: expect.stringContaining("/sandbox/inputs/notes"),
      }),
    );

    execute.mockClear();
    const found = await find.execute("find-ro", { pattern: "*.txt", path: "/sandbox/inputs" });
    expect(found.isError).toBeFalsy();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("/sandbox/inputs") }),
    );

    execute.mockClear();
    const listed = await ls.execute("ls-ro", { path: "/sandbox/inputs" });
    expect(listed.isError).toBeFalsy();
    expect(textOf(listed)).toContain("mounted-hit");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.stringContaining("/sandbox/inputs") }),
    );

    for (const outside of ["/etc/passwd", "/sandbox/other", "/sandbox/inputs-extra"]) {
      execute.mockClear();
      const result = await grep.execute("grep-out", { pattern: "secret", path: outside });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/sandbox/i);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it("does not let read use the read-only mount", async () => {
    const read = createSandboxReadTool({
      containerName: "box",
      readonlyDir: "/sandbox/inputs",
    }) as SearchTool;
    const result = await read.execute("read-ro", { path: "/sandbox/inputs/secret.txt" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/sandbox/i);
    expect(textOf(result)).not.toMatch(/failed to exec|ENOENT/i);
    expect(textOf(result)).not.toContain(`${SANDBOX_MOUNT_PATH}/sandbox`);
  });
});

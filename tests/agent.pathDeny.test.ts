import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  createDurableRootPathDenyExtension,
  STAGEFLOW_PATH_DENIED,
} from "../src/agent/piAdapter.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  resetGlobalStageflowHomeForTests();
  delete process.env.STAGEFLOW_HOME;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: { cwd: string },
) => Promise<{ block?: boolean; reason?: string } | void | undefined>;

async function installPathDeny(
  runWorkspaceDir: string,
  durableRoot: string,
): Promise<ToolCallHandler> {
  let handler: ToolCallHandler | undefined;
  const pi = {
    on(event: string, h: ToolCallHandler) {
      if (event === "tool_call") handler = h;
    },
  } as unknown as ExtensionAPI;
  const factory = createDurableRootPathDenyExtension({
    runWorkspaceDir,
    durableRoot,
  });
  await factory(pi);
  if (!handler) {
    throw new Error("path deny extension did not register tool_call");
  }
  return handler;
}

async function setupHomeWithRun(): Promise<{
  durableRoot: string;
  runWorkspaceDir: string;
  cwd: string;
}> {
  const durableRoot = await makeTempDir("sf-path-deny-home-");
  process.env.STAGEFLOW_HOME = durableRoot;
  resetGlobalStageflowHomeForTests();
  await mkdir(path.join(durableRoot, "agent"), { recursive: true });
  await writeFile(
    path.join(durableRoot, "agent", "auth.json"),
    JSON.stringify({ secret: "nope" }),
  );
  await writeFile(path.join(durableRoot, "state.db"), "sqlite-bytes");
  const runWorkspaceDir = path.join(durableRoot, "runs", "run-1");
  await mkdir(runWorkspaceDir, { recursive: true });
  const cwd = await makeTempDir("sf-path-deny-cwd-");
  return { durableRoot, runWorkspaceDir, cwd };
}

describe("Pi durable-root path deny", () => {
  it("read of $STAGEFLOW_HOME/agent/auth.json returns stageflow_path_denied", async () => {
    const { durableRoot, runWorkspaceDir, cwd } = await setupHomeWithRun();
    const onToolCall = await installPathDeny(runWorkspaceDir, durableRoot);
    const result = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "1",
        toolName: "read",
        input: { path: path.join(durableRoot, "agent", "auth.json") },
      },
      { cwd },
    );
    expect(result).toEqual({
      block: true,
      reason: STAGEFLOW_PATH_DENIED,
    });
  });

  it("read of $STAGEFLOW_HOME/state.db returns stageflow_path_denied", async () => {
    const { durableRoot, runWorkspaceDir, cwd } = await setupHomeWithRun();
    const onToolCall = await installPathDeny(runWorkspaceDir, durableRoot);
    const result = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "2",
        toolName: "read",
        input: { path: path.join(durableRoot, "state.db") },
      },
      { cwd },
    );
    expect(result).toEqual({
      block: true,
      reason: STAGEFLOW_PATH_DENIED,
    });
  });

  it("write of a file inside the run workspace is not blocked", async () => {
    const { durableRoot, runWorkspaceDir, cwd } = await setupHomeWithRun();
    const target = path.join(runWorkspaceDir, "notes.txt");
    const onToolCall = await installPathDeny(runWorkspaceDir, durableRoot);
    const result = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "3",
        toolName: "write",
        input: { path: target, content: "ok" },
      },
      { cwd },
    );
    expect(result).toBeUndefined();
  });

  it("read of a workspace symlink to state.db returns stageflow_path_denied", async () => {
    const { durableRoot, runWorkspaceDir, cwd } = await setupHomeWithRun();
    const linkPath = path.join(runWorkspaceDir, "sneaky-db");
    await symlink(path.join(durableRoot, "state.db"), linkPath);
    const onToolCall = await installPathDeny(runWorkspaceDir, durableRoot);
    const result = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "4",
        toolName: "read",
        input: { path: linkPath },
      },
      { cwd },
    );
    expect(result).toEqual({
      block: true,
      reason: STAGEFLOW_PATH_DENIED,
    });
  });

  it("edit of agent/auth.json returns stageflow_path_denied", async () => {
    const { durableRoot, runWorkspaceDir, cwd } = await setupHomeWithRun();
    const onToolCall = await installPathDeny(runWorkspaceDir, durableRoot);
    const result = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "5",
        toolName: "edit",
        input: {
          path: path.join(durableRoot, "agent", "auth.json"),
          edits: [{ oldText: "a", newText: "b" }],
        },
      },
      { cwd },
    );
    expect(result).toEqual({
      block: true,
      reason: STAGEFLOW_PATH_DENIED,
    });
  });

  it("a path outside the durable root is not denied by this rule", async () => {
    const { durableRoot, runWorkspaceDir, cwd } = await setupHomeWithRun();
    const outside = path.join(cwd, "outside.txt");
    await writeFile(outside, "hello");
    const onToolCall = await installPathDeny(runWorkspaceDir, durableRoot);
    const result = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "6",
        toolName: "read",
        input: { path: outside },
      },
      { cwd },
    );
    expect(result).toBeUndefined();
  });

  it("bash is not path-restricted", async () => {
    const { durableRoot, runWorkspaceDir, cwd } = await setupHomeWithRun();
    const onToolCall = await installPathDeny(runWorkspaceDir, durableRoot);
    const result = await onToolCall(
      {
        type: "tool_call",
        toolCallId: "7",
        toolName: "bash",
        input: { command: `cat ${path.join(durableRoot, "state.db")}` },
      },
      { cwd },
    );
    expect(result).toBeUndefined();
  });
});

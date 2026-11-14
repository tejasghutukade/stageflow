import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import * as childProcess from "node:child_process";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PiAgentAdapter, createStageSessionManager } from "../src/agent/piAdapter.js";
import type { StageRunInput } from "../src/agent/port.js";
import {
  freezeHostLoginServers,
  hostLoginAttemptKey,
  resetFrozenHostLoginServersForTests,
} from "../src/config/hostLoginMcp.js";
import { saveHostMcpServer } from "../src/config/mcpHostCatalog.js";
import * as mcpOAuth from "../src/config/mcpOAuth.js";
import { OAUTH_FILE_KEY_ENV } from "../src/config/mcpOAuth.js";
import { resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import {
  STAGE_MCP_NATIVE_TOOLS_REASON,
  setStageMcpUpstreamForTests,
  type StageMcpUpstream,
} from "../src/runtime/stageMcpHost.js";
import { callStageMcpTool, listStageMcpTools, type StageMcpCallRequest } from "../src/runtime/stageMcpWorker.js";

const piSdkMocks = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  order: [] as string[],
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession: piSdkMocks.createAgentSession,
  };
});

const ACCESS = "sf-access-token-DO-NOT-LEAK";
const REFRESH = "sf-refresh-token-DO-NOT-LEAK";
const FILE_KEY = "sf-file-key-DO-NOT-LEAK";

let home: string;
let root: string;
let prevHome: string | undefined;
let prevFileKey: string | undefined;

beforeEach(async () => {
  prevHome = process.env.STAGEFLOW_HOME;
  prevFileKey = process.env[OAUTH_FILE_KEY_ENV];
  home = await mkdtemp(path.join(tmpdir(), "sf-stage-mcp-home-"));
  root = await mkdtemp(path.join(tmpdir(), "sf-stage-mcp-root-"));
  process.env.STAGEFLOW_HOME = home;
  process.env[OAUTH_FILE_KEY_ENV] = FILE_KEY;
  resetGlobalStageflowHomeForTests();
  resetFrozenHostLoginServersForTests();
  setStageMcpUpstreamForTests(undefined);
  piSdkMocks.order.length = 0;
  piSdkMocks.createAgentSession.mockReset();
  piSdkMocks.createAgentSession.mockImplementation(async () => ({
    session: {
      bindExtensions: async () => {},
      setModel: async () => {},
      setThinkingLevel: () => {},
      prompt: async () => {},
      abort: async () => {},
      dispose: () => {},
      subscribe: () => () => {},
      agent: {
        state: { messages: [] },
        continue: async () => {
          piSdkMocks.order.push("continue");
        },
      },
    },
  }));
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.STAGEFLOW_HOME;
  else process.env.STAGEFLOW_HOME = prevHome;
  if (prevFileKey === undefined) delete process.env[OAUTH_FILE_KEY_ENV];
  else process.env[OAUTH_FILE_KEY_ENV] = prevFileKey;
  resetGlobalStageflowHomeForTests();
  resetFrozenHostLoginServersForTests();
  setStageMcpUpstreamForTests(undefined);
});

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stdout = null;
  child.stderr = null;
  child.connected = true;
  child.pid = 51;
  child.kill = (() => true) as ChildProcess["kill"];
  child.send = (() => true) as ChildProcess["send"];
  return child;
}

function boardsUpstream(calls: string[] = []): StageMcpUpstream {
  return {
    async list(_server, _signal) {
      piSdkMocks.order.push("list");
      calls.push("list");
      return {
        ok: true,
        tools: [
          { name: "get_artboards", description: "Get artboards" },
          { name: "delete_artboard", description: "Delete an artboard" },
        ],
      };
    },
    async call() {
      calls.push("call");
      return Object.assign(
        { ok: true as const, text: "boards" },
        { accessToken: ACCESS, refreshToken: REFRESH, fileKey: FILE_KEY },
      );
    },
  };
}

function launchRequest(
  child: ChildProcess,
  message: unknown,
  stage: {
    mcp?: string[];
    mcp_tools?: Record<string, string[]>;
  },
  bindingKind: "checkout" | "repository",
  runId = "run-mcp",
  stageId = "inventory",
) {
  const sent: unknown[] = [];
  let childEnv: NodeJS.ProcessEnv | undefined;
  child.send = ((payload: unknown) => {
    sent.push(payload);
    return true;
  }) as ChildProcess["send"];
  const launcher = new StageProcessLauncher({
    cliEntry: "unused",
    forkFn: ((_module, _args, options) => {
      childEnv = options?.env;
      queueMicrotask(() => {
        child.emit("message", message);
      });
      return child;
    }) as typeof childProcess.fork,
  });
  const pending = launcher.launch({
    runId,
    stageId,
    rootDir: root,
    factoryCwd: root,
    bindingKind,
    attempt: 1,
    stage: {
      id: stageId,
      system_prompt: "list artboards",
      ...stage,
    },
  });
  return { sent, pending, childEnv: () => childEnv };
}

describe("stage MCP host", () => {
  it("returns permission_denied for an unlisted tool the worker requests and keeps the attempt up", async () => {
    saveHostMcpServer("wonder", { url: "https://wonder.example/mcp" }, home);
    const calls: string[] = [];
    setStageMcpUpstreamForTests(boardsUpstream(calls));
    const openStore = vi.spyOn(mcpOAuth, "prepareMcpOAuth");
    const child = fakeChild();
    const { sent, pending } = launchRequest(
      child,
      {
        type: "mcp.call",
        requestId: "req-unlisted",
        input: { server: "wonder", tool: "delete_artboard", arguments: {} },
      },
      { mcp: ["wonder"], mcp_tools: { wonder: ["get_artboards"] } },
      "checkout",
    );

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      type: "mcp.response",
      requestId: "req-unlisted",
      result: { ok: false, code: "permission_denied" },
    });
    expect(calls).toEqual([]);
    expect(openStore).not.toHaveBeenCalled();
    child.emit("message", { type: "succeeded" });
    await expect(pending).resolves.toEqual({ type: "succeeded" });
    openStore.mockRestore();
  });

  it("returns the host stub for a listed tool and the worker message has no token", async () => {
    saveHostMcpServer("wonder", { url: "https://wonder.example/mcp" }, home);
    const calls: string[] = [];
    setStageMcpUpstreamForTests(boardsUpstream(calls));
    const openStore = vi.spyOn(mcpOAuth, "prepareMcpOAuth");
    const child = fakeChild();
    const launched = launchRequest(
      child,
      {
        type: "mcp.call",
        requestId: "req-listed",
        input: { server: "wonder", tool: "get_artboards", arguments: { board: "a" } },
      },
      { mcp: ["wonder"], mcp_tools: { wonder: ["get_artboards"] } },
      "checkout",
      "run-listed",
    );

    await vi.waitFor(() => expect(launched.sent).toHaveLength(1));
    expect(launched.sent[0]).toEqual({
      type: "mcp.response",
      requestId: "req-listed",
      result: { ok: true, text: "boards" },
    });
    const wire = JSON.stringify(launched.sent[0]);
    expect(wire).not.toContain(ACCESS);
    expect(wire).not.toContain(REFRESH);
    expect(wire).not.toContain(FILE_KEY);
    expect(launched.childEnv()?.[OAUTH_FILE_KEY_ENV]).toBeUndefined();
    expect(calls).toEqual(["call"]);
    expect(openStore).toHaveBeenCalled();
    child.emit("message", { type: "succeeded" });
    await expect(launched.pending).resolves.toEqual({ type: "succeeded" });
    openStore.mockRestore();
  });

  it("returns the same stub for an in-process stage", async () => {
    const calls: string[] = [];
    setStageMcpUpstreamForTests(boardsUpstream(calls));
    freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-local", stageId: "inventory", attempt: 1 }), [
      { name: "wonder", url: "https://wonder.example/mcp" },
    ]);
    const view = await callStageMcpTool({
      runId: "run-local",
      stageId: "inventory",
      attempt: 1,
      stage: { mcp: ["wonder"], mcp_tools: { wonder: ["get_artboards"] } },
      server: "wonder",
      tool: "get_artboards",
      arguments: { board: "a" },
    });
    expect(view).toEqual({ ok: true, text: "boards" });
    const wire = JSON.stringify(view);
    expect(wire).not.toContain(ACCESS);
    expect(wire).not.toContain(REFRESH);
    expect(wire).not.toContain(FILE_KEY);
    expect(calls).toEqual(["call"]);
  });

  it("sends only the server, tool, and arguments from the worker", async () => {
    const sent: unknown[] = [];
    const listeners = new Set<(message: unknown) => void>();
    const transport = {
      connected: true,
      send(message: unknown, callback?: (error: Error | null) => void) {
        sent.push(message);
        const requestId = (message as { requestId?: string }).requestId;
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({ type: "mcp.response", requestId, result: { ok: true, text: "boards" } });
          }
        });
        callback?.(null);
        return true;
      },
      on(_event: "message", listener: (message: unknown) => void) {
        listeners.add(listener);
      },
      off(_event: "message" | "disconnect", listener?: (message?: unknown) => void) {
        if (listener) listeners.delete(listener as (message: unknown) => void);
      },
      once() {},
    };
    const request: StageMcpCallRequest = {
      runId: "run-wire",
      stageId: "inventory",
      attempt: 1,
      stage: { mcp: ["wonder"] },
      server: "wonder",
      tool: "get_artboards",
      arguments: { board: "a" },
    };
    await expect(callStageMcpTool(request, transport)).resolves.toEqual({ ok: true, text: "boards" });
    expect(sent[0]).toEqual({
      type: "mcp.call",
      requestId: expect.any(String),
      input: { server: "wonder", tool: "get_artboards", arguments: { board: "a" } },
    });
    const wire = JSON.stringify(sent[0]);
    expect(wire).not.toContain(ACCESS);
    expect(wire).not.toContain(REFRESH);
    expect(wire).not.toContain(FILE_KEY);
  });

  it("returns permission_denied for a server outside the parent set and does not open the store", async () => {
    saveHostMcpServer("wonder", { url: "https://wonder.example/mcp" }, home);
    const calls: string[] = [];
    setStageMcpUpstreamForTests(boardsUpstream(calls));
    const openStore = vi.spyOn(mcpOAuth, "prepareMcpOAuth");
    freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-outside", stageId: "inventory", attempt: 1 }), [
      { name: "only-in-child-map", url: "https://child.example/mcp" },
    ]);
    const child = fakeChild();
    const { sent, pending } = launchRequest(
      child,
      {
        type: "mcp.call",
        requestId: "req-outside",
        input: { server: "only-in-child-map", tool: "get_artboards", arguments: {} },
      },
      { mcp: ["wonder"], mcp_tools: { wonder: ["get_artboards"] } },
      "checkout",
      "run-outside",
    );

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      type: "mcp.response",
      requestId: "req-outside",
      result: { ok: false, code: "permission_denied" },
    });
    expect(calls).toEqual([]);
    expect(openStore).not.toHaveBeenCalled();
    child.emit("message", { type: "succeeded" });
    await expect(pending).resolves.toEqual({ type: "succeeded" });
    openStore.mockRestore();
  });

  it("returns permission_denied for a console name on a repository-bound attempt and does not open the store", async () => {
    saveHostMcpServer("console-wonder", { url: "https://console.example/mcp" }, home);
    const calls: string[] = [];
    setStageMcpUpstreamForTests(boardsUpstream(calls));
    const openStore = vi.spyOn(mcpOAuth, "prepareMcpOAuth");
    freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-repo", stageId: "inventory", attempt: 1 }), [
      { name: "console-wonder", url: "https://console.example/mcp" },
    ]);
    const child = fakeChild();
    const { sent, pending } = launchRequest(
      child,
      {
        type: "mcp.call",
        requestId: "req-repo",
        input: { server: "console-wonder", tool: "get_artboards", arguments: {} },
      },
      { mcp: ["console-wonder"] },
      "repository",
      "run-repo",
    );

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      type: "mcp.response",
      requestId: "req-repo",
      result: { ok: false, code: "permission_denied" },
    });
    expect(calls).toEqual([]);
    expect(openStore).not.toHaveBeenCalled();
    child.emit("message", { type: "succeeded" });
    await expect(pending).resolves.toEqual({ type: "succeeded" });
    openStore.mockRestore();
  });

  it("lists every stubbed name for a server-name list over IPC", async () => {
    saveHostMcpServer("wonder", { url: "https://wonder.example/mcp" }, home);
    freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-list", stageId: "inventory", attempt: 1 }), [
      { name: "only-in-child-map", url: "https://child.example/mcp" },
    ]);
    setStageMcpUpstreamForTests(boardsUpstream());
    const child = fakeChild();
    const { sent, pending } = launchRequest(
      child,
      { type: "mcp.list", requestId: "req-list" },
      { mcp: ["wonder"] },
      "checkout",
      "run-list",
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({
      type: "mcp.response",
      requestId: "req-list",
      result: {
        ok: true,
        tools: [
          { server: "wonder", name: "get_artboards", description: "Get artboards" },
          { server: "wonder", name: "delete_artboard", description: "Delete an artboard" },
        ],
      },
    });
    const wire = JSON.stringify(sent[0]);
    expect(wire).not.toContain(ACCESS);
    expect(wire).not.toContain(REFRESH);
    expect(wire).not.toContain(FILE_KEY);
    expect(wire).not.toContain("only-in-child-map");
    child.emit("message", { type: "succeeded" });
    await expect(pending).resolves.toEqual({ type: "succeeded" });
  });

  it("cancels the in-flight host call when the worker exits", async () => {
    saveHostMcpServer("wonder", { url: "https://wonder.example/mcp" }, home);
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    setStageMcpUpstreamForTests({
      async list() {
        return { ok: true, tools: [] };
      },
      call(_server, _tool, _args, signal) {
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ ok: false, code: "cancelled", message: "cancelled" });
          });
          started();
        });
      },
    });
    const child = fakeChild();
    const { pending } = launchRequest(
      child,
      {
        type: "mcp.call",
        requestId: "req-cancel",
        input: { server: "wonder", tool: "get_artboards", arguments: {} },
      },
      { mcp: ["wonder"] },
      "checkout",
      "run-cancel",
    );
    await startedPromise;
    child.emit("exit", 0, null);
    await expect(pending).resolves.toEqual({ type: "succeeded" });
    expect(aborted).toBe(true);
  });

  it("offers every name from a stubbed list when mcp is a server-name list", async () => {
    setStageMcpUpstreamForTests(boardsUpstream());
    freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-all", stageId: "inventory", attempt: 1 }), [
      { name: "wonder", url: "https://wonder.example/mcp" },
    ]);
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-stage-mcp-all-"));
    await new PiAgentAdapter().runStage(stageInput(runWs, "run-all", { mcp: ["wonder"] }));
    expect(sessionToolNames()).toEqual(expect.arrayContaining(["wonder_get_artboards", "wonder_delete_artboard"]));
  });

  it("omits tool names the stage did not list", async () => {
    setStageMcpUpstreamForTests(boardsUpstream());
    freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-named", stageId: "inventory", attempt: 1 }), [
      { name: "wonder", url: "https://wonder.example/mcp" },
    ]);
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-stage-mcp-named-"));
    await new PiAgentAdapter().runStage(stageInput(runWs, "run-named", {
      mcp: ["wonder"],
      mcp_tools: { wonder: ["get_artboards"] },
    }));
    const names = sessionToolNames();
    expect(names).toContain("wonder_get_artboards");
    expect(names).not.toContain("wonder_delete_artboard");
  });

  it("asks for a fresh tool list before a restored session continues", async () => {
    setStageMcpUpstreamForTests(boardsUpstream());
    freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-resume", stageId: "inventory", attempt: 1 }), [
      { name: "wonder", url: "https://wonder.example/mcp" },
    ]);
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-stage-mcp-resume-"));
    const roots = buildStageRoots(runWs, "inventory");
    const session = await createStageSessionManager(roots, "inventory");
    session.appendMessage({ role: "user", content: "start", timestamp: Date.now() });
    session.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_wait_1", name: "ask_operator", arguments: { prompt: "go" } }],
      timestamp: Date.now(),
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
    });
    const handle = new PiAgentAdapter().openStage({
      ...stageInput(runWs, "run-resume", { mcp: ["wonder"] }),
      sessionMode: "waiting_resume",
    });
    await vi.waitFor(() => expect(piSdkMocks.order).toContain("list"));
    expect(piSdkMocks.order).not.toContain("continue");
    handle.deliverAnswer({ text: "go" });
    await handle.next();
    expect(piSdkMocks.order.indexOf("list")).toBeLessThan(piSdkMocks.order.indexOf("continue"));
    await handle.close();
  });

  it("fails a named allowlist on a runtime that executes its own tools before the model", async () => {
    const create = vi.spyOn(ModelRuntime, "create");
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-stage-mcp-cursor-"));
    const result = await new PiAgentAdapter().runStage(stageInput(runWs, "run-cursor", {
      model: "cursor/composer",
      mcp: ["wonder"],
      mcp_tools: { wonder: ["get_artboards"] },
    }));
    expect(result).toEqual({ ok: false, reason: STAGE_MCP_NATIVE_TOOLS_REASON });
    expect(create).not.toHaveBeenCalled();
    expect(piSdkMocks.createAgentSession).not.toHaveBeenCalled();
    create.mockRestore();
  });

  it("treats a star list as every tool of that server", async () => {
    setStageMcpUpstreamForTests(boardsUpstream());
    freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-star", stageId: "inventory", attempt: 1 }), [
      { name: "wonder", url: "https://wonder.example/mcp" },
    ]);
    const listed = await listStageMcpTools({
      runId: "run-star",
      stageId: "inventory",
      attempt: 1,
      stage: { mcp: ["wonder"], mcp_tools: { wonder: ["*"] } },
    });
    expect(listed).toEqual({
      ok: true,
      tools: [
        { server: "wonder", name: "get_artboards", description: "Get artboards" },
        { server: "wonder", name: "delete_artboard", description: "Delete an artboard" },
      ],
    });
  });
});

function stageInput(
  runWs: string,
  runId: string,
  stage: Partial<StageRunInput["stage"]>,
): StageRunInput {
  return {
    roots: buildStageRoots(runWs, "inventory"),
    runId,
    stage: {
      id: "inventory",
      system_prompt: "list artboards",
      model: "anthropic/claude-sonnet-4-5",
      ...stage,
    },
    task: { id: "t", goal: "g" },
    priorEnvelope: null,
  };
}

function sessionToolNames(): string[] {
  const options = piSdkMocks.createAgentSession.mock.calls.at(-1)?.[0] as { tools?: string[] } | undefined;
  return options?.tools ?? [];
}

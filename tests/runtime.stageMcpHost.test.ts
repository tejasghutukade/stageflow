import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
import { OAUTH_FILE_KEY_ENV, useHostMcpGrantEnv } from "../src/config/mcpOAuth.js";
import { handleProjectMcpRoutes } from "../src/server/projectMcpRoutes.js";
import { updateMcpOAuthTokensForUrl } from "pi-mcp-adapter/oauth";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { globalStageflowHome, resetGlobalStageflowHomeForTests } from "../src/project/globalHome.js";
import { buildStageRoots } from "../src/runtime/stageRoots.js";
import { StageProcessLauncher } from "../src/runtime/stageProcessLauncher.js";
import {
  STAGE_MCP_NATIVE_TOOLS_REASON,
  classifyParentHostLogin,
  filterStageWorkerMcpToolNames,
  refusalForStoredGrant,
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
let prevAgentDir: string | undefined;

beforeEach(async () => {
  prevHome = process.env.STAGEFLOW_HOME;
  prevFileKey = process.env[OAUTH_FILE_KEY_ENV];
  prevAgentDir = process.env.PI_CODING_AGENT_DIR;
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
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
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

  it("does not open the store for a console name on a repository-bound attempt", async () => {
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
      result: { ok: false, code: "connect_failed" },
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

const VALID_KEY = Buffer.alloc(32, 4).toString("base64");

function useGrantDir(): void {
  process.env[OAUTH_FILE_KEY_ENV] = VALID_KEY;
  process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
  useHostMcpGrantEnv();
}

async function storeGrant(name: string, url: string, access = ACCESS, refresh = REFRESH): Promise<void> {
  useGrantDir();
  await updateMcpOAuthTokensForUrl(name, url, {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  }, { credentialStore: "encrypted-file" });
  const origin = new URL(url).origin;
  const account = `sha256-${createHash("sha256").update(name, "utf8").digest("hex")}`;
  const lockRoot = path.join(globalStageflowHome(), "mcp-oauth-locks", account);
  await mkdir(lockRoot, { recursive: true });
  await writeFile(path.join(lockRoot, "signin.json"), JSON.stringify({
    issuer: origin,
    tokenEndpoint: `${origin}/token`,
  }));
}

describe("stage MCP grant", () => {
  it("ends needs_auth before the model when no grant is stored and does not list tools", async () => {
    useGrantDir();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-none", stageId: "inventory", attempt: 1 }), [
      { name: "wonder", url: "https://wonder.example/mcp" },
    ]);
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-stage-mcp-none-"));
    const result = await new PiAgentAdapter().runStage(stageInput(runWs, "run-none", {
      mcp: ["wonder"],
      mcp_tools: { wonder: ["get_artboards"] },
    }));
    expect(result).toEqual({ ok: false, reason: "needs_auth" });
    expect(piSdkMocks.createAgentSession).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("removes an access token from a stubbed success body and leaves the rest of the text", async () => {
    await storeGrant("wonder", "https://wonder.example/mcp");
    freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-strip", stageId: "inventory", attempt: 1 }), [
      { name: "wonder", url: "https://wonder.example/mcp" },
    ]);
    setStageMcpUpstreamForTests({
      async list() {
        return { ok: true, tools: [{ name: "get_artboards" }] };
      },
      async call() {
        return { ok: true, text: `keep ${ACCESS} and ${REFRESH} plus ${VALID_KEY} tail` };
      },
    });
    const view = await callStageMcpTool({
      runId: "run-strip",
      stageId: "inventory",
      attempt: 1,
      stage: { mcp: ["wonder"] },
      server: "wonder",
      tool: "get_artboards",
      arguments: {},
    });
    expect(view).toEqual({ ok: true, text: "keep  and  plus  tail" });
  });

  it("fails the attempt before the model when a named tool is absent from the list", async () => {
    setStageMcpUpstreamForTests({
      async list() {
        piSdkMocks.order.push("list");
        return { ok: true, tools: [{ name: "delete_artboard", description: "Delete an artboard" }] };
      },
      async call() {
        return { ok: true, text: "boards" };
      },
    });
    freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-missing", stageId: "inventory", attempt: 1 }), [
      { name: "wonder", url: "https://wonder.example/mcp" },
    ]);
    const runWs = await mkdtemp(path.join(tmpdir(), "sf-stage-mcp-missing-"));
    const result = await new PiAgentAdapter().runStage(stageInput(runWs, "run-missing", {
      mcp: ["wonder"],
      mcp_tools: { wonder: ["get_artboards"] },
    }));
    expect(result).toEqual({ ok: false, reason: "mcp_tool_missing" });
    expect(piSdkMocks.order).toContain("list");
    expect(piSdkMocks.createAgentSession).not.toHaveBeenCalled();
  });

  it("lists again for a resume worker and the worker messages contain no token", async () => {
    const seen = await withGrantServer(async (url, hits) => {
      await storeGrant("wonder", url);
      saveHostMcpServer("wonder", { url }, home);
      hits.mode = "describe";
      freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-token-resume", stageId: "inventory", attempt: 1 }), [
        { name: "wonder", url },
      ]);
      const child = fakeChild();
      const launched = launchRequest(
        child,
        { type: "mcp.list", requestId: "req-token-list" },
        { mcp: ["wonder"] },
        "checkout",
        "run-token-resume",
      );
      await vi.waitFor(() => expect(launched.sent).toHaveLength(1));
      const first = JSON.stringify(launched.sent[0]);
      expect(first).toContain("boards");
      expect(first).toContain("stay");
      expect(first).not.toContain(ACCESS);
      expect(first).not.toContain(REFRESH);
      expect(first).not.toContain(VALID_KEY);
      child.emit("message", { type: "succeeded" });
      await launched.pending;
      const resumeChild = fakeChild();
      const again = launchRequest(
        resumeChild,
        { type: "mcp.list", requestId: "req-token-resume" },
        { mcp: ["wonder"] },
        "checkout",
        "run-token-resume-2",
      );
      await vi.waitFor(() => expect(again.sent).toHaveLength(1));
      const second = JSON.stringify(again.sent[0]);
      expect(second).not.toContain(ACCESS);
      expect(second).not.toContain(REFRESH);
      expect(second).not.toContain(VALID_KEY);
      expect(hits.listPosts).toBe(2);
      resumeChild.emit("message", { type: "succeeded" });
      await again.pending;
      return hits;
    });
    expect(seen.tokenPosts).toBe(0);
  });

  it("makes the next call needs_auth after the console server is deleted and does not refresh", async () => {
    await withGrantServer(async (url, hits) => {
      await storeGrant("wonder", url);
      saveHostMcpServer("wonder", { url }, home);
      freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-delete", stageId: "inventory", attempt: 1 }), [
        { name: "wonder", url },
      ]);
      const listed = await listStageMcpTools({
        runId: "run-delete",
        stageId: "inventory",
        attempt: 1,
        stage: { mcp: ["wonder"] },
      });
      expect(listed.ok).toBe(true);
      let status = 0;
      await handleProjectMcpRoutes(
        { method: "DELETE", url: "/api/project-mcp/wonder" } as IncomingMessage,
        {} as ServerResponse,
        {
          projectRoot: root,
          readJsonBody: async () => ({}),
          json: (_res, code) => { status = code; },
        },
      );
      expect(status).toBe(200);
      const called = await callStageMcpTool({
        runId: "run-delete",
        stageId: "inventory",
        attempt: 1,
        stage: { mcp: ["wonder"] },
        server: "wonder",
        tool: "get_artboards",
        arguments: {},
      });
      expect(called).toMatchObject({ ok: false, code: "needs_auth" });
      expect(hits.tokenPosts).toBe(0);
      expect(hits.authorizeHits).toBe(0);
    });
  });

  it("keeps insufficient_scope distinct and does not refresh", async () => {
    await withGrantServer(async (url, hits) => {
      await storeGrant("wonder", url);
      hits.mode = "insufficient_scope";
      freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-scope", stageId: "inventory", attempt: 1 }), [
        { name: "wonder", url },
      ]);
      const listed = await listStageMcpTools({
        runId: "run-scope",
        stageId: "inventory",
        attempt: 1,
        stage: { mcp: ["wonder"] },
      });
      expect(listed).toMatchObject({ ok: false, code: "insufficient_scope" });
      expect(hits.tokenPosts).toBe(0);
      expect(hits.authorizeHits).toBe(0);
    });
  });

  it("reports a plain 403 and a DNS failure as connect_failed without starting sign-in", async () => {
    await withGrantServer(async (url, hits) => {
      await storeGrant("wonder", url);
      hits.mode = "forbidden";
      freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-403", stageId: "inventory", attempt: 1 }), [
        { name: "wonder", url },
      ]);
      const forbidden = await listStageMcpTools({
        runId: "run-403",
        stageId: "inventory",
        attempt: 1,
        stage: { mcp: ["wonder"] },
      });
      expect(forbidden).toMatchObject({ ok: false, code: "connect_failed" });
      expect(hits.tokenPosts).toBe(0);
      expect(hits.authorizeHits).toBe(0);
    });

    useGrantDir();
    await storeGrant("wonder", "http://dns.invalid/mcp");
    const realFetch = globalThis.fetch;
    const hits = { tokenPosts: 0, authorizeHits: 0 };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const target = input instanceof Request ? input.url : String(input);
      if (target.includes("/token")) hits.tokenPosts += 1;
      if (target.includes("/authorize")) hits.authorizeHits += 1;
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });
    }) as typeof fetch;
    try {
      freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-dns", stageId: "inventory", attempt: 1 }), [
        { name: "wonder", url: "http://dns.invalid/mcp" },
      ]);
      const failed = await listStageMcpTools({
        runId: "run-dns",
        stageId: "inventory",
        attempt: 1,
        stage: { mcp: ["wonder"] },
      });
      expect(failed).toMatchObject({ ok: false, code: "connect_failed" });
      expect(hits.tokenPosts).toBe(0);
      expect(hits.authorizeHits).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not fail the attempt when a refresh during the list succeeds", async () => {
    await withGrantServer(async (url, hits) => {
      hits.mode = "refresh-list";
      await storeGrant("wonder", url, "at-old", "rt-old");
      freezeHostLoginServers(hostLoginAttemptKey({ runId: "run-refresh-ok", stageId: "inventory", attempt: 1 }), [
        { name: "wonder", url },
      ]);
      const runWs = await mkdtemp(path.join(tmpdir(), "sf-stage-mcp-refresh-"));
      const result = await new PiAgentAdapter().runStage(stageInput(runWs, "run-refresh-ok", { mcp: ["wonder"] }));
      expect(piSdkMocks.createAgentSession).toHaveBeenCalled();
      expect(result.ok === false ? result.reason : "").not.toBe("needs_auth");
      expect(sessionToolNames()).toContain("wonder_get_artboards");
    });
  });
});

type GrantHits = {
  mode: "ok" | "describe" | "insufficient_scope" | "forbidden" | "refresh-list";
  listPosts: number;
  tokenPosts: number;
  authorizeHits: number;
};

async function withGrantServer<T>(run: (url: string, hits: GrantHits) => Promise<T>): Promise<T> {
  const hits: GrantHits = { mode: "ok", listPosts: 0, tokenPosts: 0, authorizeHits: 0 };
  const server: Server = createServer((req, res) => {
    const origin = `http://${req.headers.host}`;
    const url = new URL(req.url ?? "/", origin);
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/authorize") {
      hits.authorizeHits += 1;
      return json(404, {});
    }
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.startsWith("/.well-known/openid-configuration")) {
      return json(200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
        json(201, { ...body, client_id: "fake-client", token_endpoint_auth_method: "none" });
      });
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      hits.tokenPosts += 1;
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => json(200, { access_token: "at-new", refresh_token: "rt-new", token_type: "Bearer", expires_in: 3600 }));
      return;
    }
    if (req.method === "GET") {
      res.writeHead(405);
      return res.end();
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const msg = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (msg.method === "tools/list") hits.listPosts += 1;
      if (msg.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      if (hits.mode === "insufficient_scope" && msg.method === "tools/list") {
        return json(403, { error: "insufficient_scope" }, {
          "www-authenticate": 'Bearer error="insufficient_scope", scope="boards.write"',
        });
      }
      if (hits.mode === "forbidden" && msg.method === "tools/list") {
        return json(403, { error: "forbidden" });
      }
      const bearer = req.headers.authorization;
      if (hits.mode === "refresh-list" && msg.method === "tools/list" && bearer !== "Bearer at-new") {
        return json(401, { error: "invalid_token" }, {
          "www-authenticate": 'Bearer error="invalid_token"',
        });
      }
      const description = hits.mode === "describe" ? `boards ${ACCESS} ${REFRESH} ${VALID_KEY} stay` : "Get artboards";
      const result = msg.method === "initialize"
        ? { protocolVersion: msg.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }
        : msg.method === "tools/list"
          ? { tools: [{ name: "get_artboards", description, inputSchema: { type: "object", properties: {} } }] }
          : {};
      json(200, { jsonrpc: "2.0", id: msg.id, result });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${address.port}/mcp`, hits);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("review fixes", () => {
  it("keeps only named worker tools and every tool of a star server", () => {
    const stage = {
      mcp: ["echo", "files"],
      mcp_tools: { echo: ["ping"], files: ["*"] },
    };
    const names = filterStageWorkerMcpToolNames(stage, ["echo", "files"], [
      "echo_ping",
      "echo_delete",
      "files_read",
      "other_ping",
    ]);
    expect(names).toEqual(["echo_ping", "files_read"]);
  });

  it("does not treat an expired grant as signed out", () => {
    expect(refusalForStoredGrant("expired")).toBeUndefined();
    expect(refusalForStoredGrant("authenticated")).toBeUndefined();
    expect(refusalForStoredGrant("not_authenticated")?.code).toBe("needs_auth");
    expect(refusalForStoredGrant("unavailable")?.code).toBe("connect_failed");
  });

  it("throws when the parent cannot resolve the catalog", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-mcp-classify-"));
    await expect(classifyParentHostLogin({
      stage: { mcp: ["missing"] },
      rootDir: root,
      factoryCwd: root,
    })).rejects.toThrow();
  });

  it("cancels the parent call when the worker stops waiting", async () => {
    const sent: unknown[] = [];
    const transport = new EventEmitter() as EventEmitter & {
      connected: boolean;
      send: (message: unknown) => boolean;
    };
    transport.connected = true;
    transport.send = (message: unknown) => {
      sent.push(message);
      return true;
    };
    const result = await callStageMcpTool({
      stageId: "inventory",
      stage: { mcp: ["wonder"] },
      server: "wonder",
      tool: "get_artboards",
      arguments: {},
      timeoutMs: 20,
    }, transport);
    expect(result).toMatchObject({ ok: false, code: "cancelled" });
    expect(sent).toEqual([
      expect.objectContaining({ type: "mcp.call" }),
      expect.objectContaining({ type: "mcp.cancel" }),
    ]);
  });
});

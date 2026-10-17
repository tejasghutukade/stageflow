import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { loadControlTokens } from "../src/server/controlToken.js";
import { startUiServer } from "../src/server/http.js";
import { closeServer } from "./helpers/closeServer.js";
import { scriptedBackend } from "./helpers/agentsHarness.js";
import { bindStageflowHomeForTests } from "./helpers/workspaceTestHarness.js";

const DRIVE = "d".repeat(32);
const VISITOR = "visitor_aaaaaaaaaaaa";
const OTHER = "visitor_bbbbbbbbbbbb";
const servers: Array<{ close: (cb?: () => void) => void }> = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function startHost(backend: ReturnType<typeof scriptedBackend> = scriptedBackend()) {
  const home = await mkdtemp(path.join(tmpdir(), "sf-webchat-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-webchat-project-"));
  dirs.push(home, project);
  await mkdir(path.join(project, "agents"));
  bindStageflowHomeForTests(home);
  const started = await startUiServer({
    agent: scriptedFakeAgent([]),
    cwd: project,
    rootDir: home,
    store: createRunStore({ rootDir: home }),
    port: 0,
    uiDistDir: path.join(home, "missing-ui"),
    controlTokens: loadControlTokens({ STAGEFLOW_CONTROL_TOKEN: DRIVE }),
    agentConversationBackend: backend,
  });
  servers.push(started.server);
  const address = started.server.address();
  if (!address || typeof address === "string") throw new Error("expected a port");
  const base = `http://127.0.0.1:${address.port}`;
  const admin = async (method: string, urlPath: string, body?: unknown) => {
    const response = await fetch(`${base}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${DRIVE}`, "Content-Type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> };
  };
  // Public calls carry no console token: the slug is the credential.
  const pub = async (slug: string, suffix: string, init: { method?: string; visitor?: string; body?: unknown } = {}) => {
    const response = await fetch(`${base}/api/public/chat/${slug}${suffix}`, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json", ...(init.visitor ? { "x-visitor-id": init.visitor } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    return response;
  };
  const frames = async (response: Response) =>
    (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
  return { base, admin, pub, frames };
}

async function liveAgent(host: Awaited<ReturnType<typeof startHost>>, overrides: Record<string, unknown> = {}) {
  const created = await host.admin("POST", "/api/agents", { definition: { id: "helper", name: "Helper", instructions: "Help.", greeting: "Hi there", ...overrides } });
  expect(created.status).toBe(201);
  await host.admin("POST", "/api/agents/helper/enable");
  const detail = (await host.admin("GET", "/api/agents/helper")).body;
  return { slug: detail.definition.web_chat.slug as string, detail };
}

describe("public web chat", () => {
  it("gives every new agent a link and serves it only while the agent is enabled", async () => {
    const host = await startHost();
    const created = await host.admin("POST", "/api/agents", { definition: { id: "helper", name: "Helper", instructions: "Help." } });
    const { slug } = { slug: created.body.definition.web_chat.slug as string };
    expect(slug).toMatch(/^[a-z0-9]{16}$/);
    expect(created.body.agent.webChatUrl).toBe(`/chat/${slug}`);
    expect(created.body.definition.web_chat).toMatchObject({ enabled: true, rate_limit_per_minute: 10, max_message_chars: 4000 });
    expect((await host.pub(slug, "")).status).toBe(404);
    await host.admin("POST", "/api/agents/helper/enable");
    await new Promise((resolve) => setTimeout(resolve, 1_100)); // the unavailable answer is cached for a second
    const info = await host.pub(slug, "");
    expect(info.status).toBe(200);
    expect(await info.json()).toEqual({ agent: { name: "Helper", greeting: null } });
    expect((await host.pub("wrongwrongwrong12", "")).status).toBe(404);
    expect((await host.pub("x", "")).status).toBe(404);
  });

  it("keeps each visitor's conversations private and replays the transcript", async () => {
    const host = await startHost();
    const { slug } = await liveAgent(host);
    expect((await host.pub(slug, "/threads")).status).toBe(400);
    const made = await host.pub(slug, "/threads", { method: "POST", visitor: VISITOR });
    expect(made.status).toBe(201);
    const thread = (await made.json()).thread as { id: string; title: string };
    expect(thread.title).toBe("New chat");

    const sent = await host.pub(slug, `/threads/${thread.id}/messages`, { method: "POST", visitor: VISITOR, body: { text: "hello" } });
    const stream = await host.frames(sent);
    expect(stream.filter((f) => f.type === "delta").map((f) => f.text).join("")).toBe("echo: hello");
    expect(stream.at(-1)).toMatchObject({ type: "done", message: { role: "assistant", text: "echo: hello" } });

    const history = await (await host.pub(slug, `/threads/${thread.id}`, { visitor: VISITOR })).json();
    expect(history).toMatchObject({ status: "open", thread: { title: "hello" } });
    expect(history.messages.map((m: { role: string; text: string }) => [m.role, m.text])).toEqual([["user", "hello"], ["assistant", "echo: hello"]]);
    expect(JSON.stringify(history)).not.toContain("spans");

    expect((await (await host.pub(slug, "/threads", { visitor: VISITOR })).json()).threads).toHaveLength(1);
    expect((await (await host.pub(slug, "/threads", { visitor: OTHER })).json()).threads).toEqual([]);
    expect((await host.pub(slug, `/threads/${thread.id}`, { visitor: OTHER })).status).toBe(404);
    const stolen = await host.pub(slug, `/threads/${thread.id}/messages`, { method: "POST", visitor: OTHER, body: { text: "hi" } });
    expect(stolen.status).toBe(404);

    const console = (await host.admin("GET", "/api/agents/helper/sessions")).body.sessions as Array<{ source: string; sourceRef: string }>;
    expect(console).toEqual([expect.objectContaining({ source: "web", sourceRef: VISITOR })]);
  });

  it("rate limits a visitor and rejects over-long messages with friendly errors", async () => {
    const host = await startHost();
    const { slug } = await liveAgent(host, { web_chat: { enabled: true, rate_limit_per_minute: 2, max_message_chars: 10 } });
    const { thread } = (await (await host.pub(slug, "/threads", { method: "POST", visitor: VISITOR })).json()) as { thread: { id: string } };
    const tooLong = await host.pub(slug, `/threads/${thread.id}/messages`, { method: "POST", visitor: VISITOR, body: { text: "x".repeat(11) } });
    expect(tooLong.status).toBe(413);
    expect(await tooLong.json()).toMatchObject({ code: "web_chat.message_too_long", message: expect.any(String) });
    const ok = await host.pub(slug, `/threads/${thread.id}/messages`, { method: "POST", visitor: VISITOR, body: { text: "one" } });
    expect(ok.status).toBe(200);
    await ok.text();
    const limited = await host.pub(slug, `/threads/${thread.id}/messages`, { method: "POST", visitor: VISITOR, body: { text: "two" } });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(await limited.json()).toMatchObject({ code: "web_chat.rate_limited", retryAfterSec: expect.any(Number) });
  });

  it("tells the visitor an operator is checking, and never shows tool details", async () => {
    const backend = scriptedBackend(async (_messages, ctx) => {
      const result = await ctx.tool("web.fetch", { url: "https://secret.example/token" });
      return result.ran ? "all done" : "skipped";
    });
    const host = await startHost(backend);
    const { slug } = await liveAgent(host, { tools: { mcp: { web: ["fetch"] } }, approvals: { ask_first: ["web.fetch"] } });
    const { thread } = (await (await host.pub(slug, "/threads", { method: "POST", visitor: VISITOR })).json()) as { thread: { id: string } };
    const pending = host.pub(slug, `/threads/${thread.id}/messages`, { method: "POST", visitor: VISITOR, body: { text: "go" } }).then((r) => r.text());

    let approvals: Array<{ sessionId: string }> = [];
    for (let attempt = 0; attempt < 100 && approvals.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      approvals = (await host.admin("GET", "/api/agents/approvals")).body.approvals ?? [];
    }
    expect(approvals).toHaveLength(1);
    const status = await (await host.pub(slug, `/threads/${thread.id}`, { visitor: VISITOR })).json();
    expect(status.status).toBe("waiting");
    const busy = await host.pub(slug, `/threads/${thread.id}/messages`, { method: "POST", visitor: VISITOR, body: { text: "again" } });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ code: "web_chat.busy" });

    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await host.admin("POST", `/api/agents/helper/sessions/${approvals[0]!.sessionId}/approval/approve`);
    const text = await pending;
    const stream = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
    expect(stream.map((f) => f.type)).toContain("waiting");
    expect(stream.at(-1)).toMatchObject({ type: "done", message: { text: "all done" } });
    expect(text).not.toContain("secret.example");
  });

  it("rotates the link: the old one stops working", async () => {
    const host = await startHost();
    const { slug, detail } = await liveAgent(host);
    const rotated = await host.admin("POST", "/api/agents/helper/save", {
      baseRevision: detail.agent.revision,
      definition: { ...detail.definition, web_chat: { ...detail.definition.web_chat, slug: "" } },
    });
    expect(rotated.status).toBe(200);
    const next = rotated.body.definition.web_chat.slug as string;
    expect(next).not.toBe(slug);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await host.pub(slug, "")).status).toBe(404);
    expect((await host.pub(next, "")).status).toBe(200);
  });

  it("stops serving when web chat is switched off", async () => {
    const host = await startHost();
    const { slug, detail } = await liveAgent(host);
    await host.admin("POST", "/api/agents/helper/save", {
      baseRevision: detail.agent.revision,
      definition: { ...detail.definition, web_chat: { ...detail.definition.web_chat, enabled: false } },
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect((await host.pub(slug, "")).status).toBe(404);
  });

  it("keeps the link when a client saves without a web_chat block", async () => {
    const host = await startHost();
    const { slug, detail } = await liveAgent(host);
    const { web_chat: _omit, ...rest } = detail.definition;
    const saved = await host.admin("POST", "/api/agents/helper/save", { baseRevision: detail.agent.revision, definition: { ...rest, instructions: "Help more." } });
    expect(saved.body.definition.web_chat.slug).toBe(slug);
  });
});

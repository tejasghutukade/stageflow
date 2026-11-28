import Database from "better-sqlite3";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { PRESENT_UI_TOOL_NAME } from "../src/genui/index.js";
import { catalogRootsForArtifacts } from "../src/artifacts/projectScope.js";
import { publishArtifact, type PublishRequest } from "../src/artifacts/publish.js";
import { UI_PART_KIND_ARTIFACT_REF, UI_PART_SCHEMA_VERSION } from "../src/artifacts/uiPart.js";
import { createRunStore, sqliteConnectionFromStore } from "../src/runstore/createStore.js";
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
  const home = await mkdtemp(path.join(tmpdir(), "sf-chat-art-"));
  const project = await mkdtemp(path.join(tmpdir(), "sf-chat-art-project-"));
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
  const pub = async (slug: string, suffix: string, init: { method?: string; visitor?: string; body?: unknown } = {}) =>
    fetch(`${base}/api/public/chat/${slug}${suffix}`, {
      method: init.method ?? "GET",
      headers: { "Content-Type": "application/json", ...(init.visitor ? { "x-visitor-id": init.visitor } : {}) },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  const frames = async (response: Response) =>
    (await response.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
  return { base, home, project, admin, pub, frames };
}

function openDb(home: string): Database.Database {
  const db = new Database(path.join(home, "state.db"));
  db.pragma("busy_timeout = 5000");
  return db;
}

function ref(title: string, key: string) {
  return {
    v: UI_PART_SCHEMA_VERSION,
    kind: UI_PART_KIND_ARTIFACT_REF,
    key,
    title,
    fallback: { text: title, url: "http://127.0.0.1:3847/#/artifacts/agent%3Ahelper/note?project_root=/Users/secret" },
  };
}

async function publish(home: string, project: string, input: Omit<PublishRequest, "roots" | "publishSource" | "projectRoot">) {
  const store = createRunStore({ rootDir: home });
  try {
    await store.ensureProject(project);
    const db = sqliteConnectionFromStore(store);
    if (!db) throw new Error("expected a sqlite store");
    const roots = await catalogRootsForArtifacts(store);
    return await publishArtifact(db, { roots, projectRoot: project, publishSource: "api", ...input });
  } finally {
    await store.close();
  }
}

const AGENT = {
  id: "helper",
  name: "Helper",
  instructions: "Help.",
  ui: { present: true, persistence: "artifacts" },
  limits: { cost_usd: 1 },
};

describe("public chat artifacts", () => {
  it("returns a session artifact to its visitor and 404s for everyone else", async () => {
    const presented: unknown[] = [];
    const backend = scriptedBackend(async (_messages, ctx) => {
      for (const part of presented) {
        const result = await ctx.tool(PRESENT_UI_TOOL_NAME, {}, () => JSON.stringify({ type: "ui", ui: part }));
        if (!result.ran) return result.output;
      }
      return "Shown.";
    });
    const host = await startHost(backend);
    const created = await host.admin("POST", "/api/agents", {
      definition: { ...AGENT, web_chat: { enabled: true, access: "public", public_tools: true } },
    });
    expect(created.status).toBe(201);
    await host.admin("POST", "/api/agents/helper/enable");
    const slug = created.body.definition.web_chat.slug as string;
    const { thread } = (await (await host.pub(slug, "/threads", { method: "POST", visitor: VISITOR })).json()) as { thread: { id: string } };
    const later = new Date(Date.now() + 86_400_000).toISOString();

    const note = await publish(host.home, host.project, {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      id: "chatnote",
      kind: "static.markdown",
      title: "Note",
      bytes: Buffer.from("# Hello from this chat"),
      source: { kind: "agent", sessionId: thread.id },
      scope: "session",
      expiresAt: later,
    });
    const elsewhere = await publish(host.home, host.project, {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      id: "othernote",
      kind: "static.markdown",
      title: "Other",
      bytes: Buffer.from("# Someone else"),
      source: { kind: "agent", sessionId: "not-this-session" },
      scope: "session",
      expiresAt: later,
    });
    const projectArtifact = await publish(host.home, host.project, {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      id: "weekly",
      kind: "static.markdown",
      title: "Weekly",
      bytes: Buffer.from("# Project"),
      source: { kind: "stage", runId: "run-1", stageId: "summarize", attempt: 1 },
    });
    const doomed = await publish(host.home, host.project, {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      id: "doomednote",
      kind: "static.markdown",
      title: "Doomed",
      bytes: Buffer.from("# Gone"),
      source: { kind: "agent", sessionId: thread.id },
      scope: "session",
      expiresAt: later,
    });
    await publish(host.home, host.project, {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      id: "stalenote",
      kind: "static.markdown",
      title: "Stale",
      bytes: Buffer.from("# Old"),
      source: { kind: "agent", sessionId: thread.id },
      scope: "session",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    presented.push(ref("Note", note.key), ref("Other", elsewhere.key), ref("Weekly", projectArtifact.key));
    const stream = await host.frames(
      await host.pub(slug, `/threads/${thread.id}/messages`, { method: "POST", visitor: VISITOR, body: { text: "show" } }),
    );
    const done = stream.at(-1);
    expect(done).toMatchObject({
      type: "done",
      message: {
        text: "Shown.",
        parts: [{ ...ref("Note", note.key), fallback: { text: "Note", url: "" } }],
      },
    });
    expect(JSON.stringify(done)).not.toContain("project_root");
    expect(JSON.stringify(done)).not.toContain("/Users/secret");

    const history = await (await host.pub(slug, `/threads/${thread.id}`, { visitor: VISITOR })).json();
    expect(history.messages.at(-1).parts).toEqual([{ ...ref("Note", note.key), fallback: { text: "Note", url: "" } }]);

    const body = await (await host.pub(slug, `/threads/${thread.id}/artifacts/${encodeURIComponent(note.key)}`, { visitor: VISITOR })).json();
    expect(body).toMatchObject({ kind: "static.markdown", title: "Note", version: 1, text: "# Hello from this chat" });
    expect(JSON.stringify(body)).not.toMatch(/project_root|source_session|\/Users|::|relative_path|"key"|"owner"/);
    const byId = await (await host.pub(slug, `/threads/${thread.id}/artifacts/chatnote?version=1`, { visitor: VISITOR })).json();
    expect(byId).toMatchObject({ kind: "static.markdown", text: "# Hello from this chat", version: 1 });

    expect((await host.pub(slug, `/threads/${thread.id}/artifacts/chatnote`, { visitor: OTHER })).status).toBe(404);
    expect((await host.pub(slug, `/threads/${thread.id}/artifacts/${encodeURIComponent(elsewhere.key)}`, { visitor: VISITOR })).status).toBe(404);
    expect((await host.pub(slug, `/threads/${thread.id}/artifacts/${encodeURIComponent(projectArtifact.key)}`, { visitor: VISITOR })).status).toBe(404);
    expect((await host.pub(slug, `/threads/${thread.id}/artifacts/stalenote`, { visitor: VISITOR })).status).toBe(404);
    expect((await host.pub(slug, `/threads/${thread.id}/artifacts/chatnote?version=2`, { visitor: VISITOR })).status).toBe(404);
    expect((await host.pub(slug, `/threads/${thread.id}/artifacts/missingnote`, { visitor: VISITOR })).status).toBe(404);

    const hiding = openDb(host.home);
    hiding.prepare(`UPDATE artifacts SET hidden = 1 WHERE id = 'chatnote'`).run();
    hiding.close();
    expect((await host.pub(slug, `/threads/${thread.id}/artifacts/chatnote`, { visitor: VISITOR })).status).toBe(404);
    const showing = openDb(host.home);
    showing.prepare(`UPDATE artifacts SET hidden = 0 WHERE id = 'chatnote'`).run();
    showing.close();
    expect((await host.pub(slug, `/threads/${thread.id}/artifacts/chatnote`, { visitor: VISITOR })).status).toBe(200);

    const db = openDb(host.home);
    db.prepare(`UPDATE artifacts SET status = 'expired', expired_reason = 'session_expired' WHERE id = 'chatnote'`).run();
    db.prepare(`UPDATE artifacts SET deleted_at = ? WHERE id = 'doomednote'`).run(new Date().toISOString());
    db.close();
    expect((await host.pub(slug, `/threads/${thread.id}/artifacts/chatnote`, { visitor: VISITOR })).status).toBe(404);
    expect((await host.pub(slug, `/threads/${thread.id}/artifacts/${encodeURIComponent(doomed.key)}`, { visitor: VISITOR })).status).toBe(404);
    const after = await (await host.pub(slug, `/threads/${thread.id}`, { visitor: VISITOR })).json();
    expect(after.messages.at(-1).parts).toBeUndefined();
  });

  it("exposes nothing when public tools are off", async () => {
    const backend = scriptedBackend(async (_messages, ctx) => {
      const result = await ctx.tool(PRESENT_UI_TOOL_NAME, {}, () => JSON.stringify({ type: "ui", ui: ref("Note", "stage:sales:summarize/chatnote") }));
      return result.ran ? "Shown." : "withheld";
    });
    const host = await startHost(backend);
    const created = await host.admin("POST", "/api/agents", {
      definition: { ...AGENT, web_chat: { enabled: true, access: "public", public_tools: false } },
    });
    expect(created.status).toBe(201);
    await host.admin("POST", "/api/agents/helper/enable");
    const slug = created.body.definition.web_chat.slug as string;
    const { thread } = (await (await host.pub(slug, "/threads", { method: "POST", visitor: VISITOR })).json()) as { thread: { id: string } };
    await publish(host.home, host.project, {
      owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
      id: "chatnote",
      kind: "static.markdown",
      title: "Note",
      bytes: Buffer.from("# Hidden"),
      source: { kind: "agent", sessionId: thread.id },
      scope: "session",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const stream = await host.frames(
      await host.pub(slug, `/threads/${thread.id}/messages`, { method: "POST", visitor: VISITOR, body: { text: "show" } }),
    );
    expect(stream.at(-1)).toMatchObject({ type: "done", message: { text: "withheld" } });
    expect(stream.at(-1).message.parts).toBeUndefined();
    expect((await host.pub(slug, `/threads/${thread.id}/artifacts/chatnote`, { visitor: VISITOR })).status).toBe(404);

    const db = openDb(host.home);
    db.prepare(
      `INSERT INTO agent_messages (message_id, session_id, seq, turn_id, role, author, text, parts_json, created_at)
       VALUES ('planted', ?, 50, NULL, 'assistant', NULL, 'planted', ?, ?)`,
    ).run(thread.id, JSON.stringify([ref("Note", "stage:sales:summarize/chatnote")]), new Date().toISOString());
    db.close();
    const history = await (await host.pub(slug, `/threads/${thread.id}`, { visitor: VISITOR })).json();
    const planted = history.messages.find((message: { text: string }) => message.text === "planted");
    expect(planted.parts).toBeUndefined();
    expect(JSON.stringify(history)).not.toContain("project_root");
    expect(JSON.stringify(history)).not.toContain("stage:sales:summarize/chatnote");
  });
});

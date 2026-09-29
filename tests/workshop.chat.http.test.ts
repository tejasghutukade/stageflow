import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createWorkshopOperatorHost } from "../src/operatorAgent/index.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { writeFactorySettings } from "../src/runtime/settingsFile.js";
import { resetWorkshopChatSessionsForTests } from "../src/workshop/chatTurn.js";
import {
  initTempGitRepo,
  withIsolatedHome,
} from "./helpers/projectContext.js";

async function jsonFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, headers: res.headers };
}

async function withServer(cwd: string, storeRoot: string) {
  const store = createRunStore({ rootDir: storeRoot });
  await store.ensureProject(cwd);
  const started = await startUiServer({
    agent: scriptedFakeAgent([]),
    cwd,
    rootDir: storeRoot,
    store,
    port: 0,
    uiDistDir: path.join(storeRoot, "missing-ui"),
    workshopOperatorHost: createWorkshopOperatorHost([
      { type: "propose_stage" },
      { type: "echo" },
    ]),
  });
  const addr = started.server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("expected TCP listen address");
  }
  const base = `http://127.0.0.1:${addr.port}`;
  return { server: started.server, base, store };
}

async function createSession(base: string, id?: string) {
  return jsonFetch(`${base}/api/workshop/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(id ? { id } : {}),
  });
}

describe("POST /api/workshop/chat", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
    resetWorkshopChatSessionsForTests();
  });

  it("runs Operator Agent Host and returns proposal + resolved model", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-chat-"));
      writeFactorySettings(repo.root, { workshopModel: "openai/gpt-5" });
      const { server, base } = await withServer(repo.root, storeRoot);
      cleanups.push(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      );
      const created = await createSession(base, "http-sess-1");
      expect(created.status).toBe(201);

      const result = await jsonFetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "http-sess-1",
          message: "intake form review",
          draft: { pipeline: { id: "demo", stages: [] } },
          autoApply: false,
        }),
      });
      expect(result.status).toBe(200);
      expect(result.body.sessionId).toBe("http-sess-1");
      expect(result.body.model).toBe("openai/gpt-5");
      expect(result.body.pending?.summary).toMatch(/Add stage/i);
      expect(
        result.body.events.some((e: { type: string }) => e.type === "proposal"),
      ).toBe(true);
      expect(result.body.draft.pipeline.stages.length).toBe(1);
      expect(result.body.pending?.nextDraft.pipeline.stages.length).toBe(1);
    });
  });

  it("prefers session model override over settings default", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-chat-"));
      writeFactorySettings(repo.root, { workshopModel: "openai/gpt-5" });
      const { server, base } = await withServer(repo.root, storeRoot);
      cleanups.push(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      );
      await createSession(base, "http-sess-model");
      const result = await jsonFetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "http-sess-model",
          message: "intake form review",
          draft: { pipeline: { id: "demo", stages: [] } },
          model: "anthropic/claude-sonnet-4-5",
        }),
      });
      expect(result.status).toBe(200);
      expect(result.body.model).toBe("anthropic/claude-sonnet-4-5");
    });
  });

  it("streams NDJSON frames when Accept requests ndjson", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-chat-"));
      const { server, base } = await withServer(repo.root, storeRoot);
      cleanups.push(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      );
      await createSession(base, "http-sess-stream");
      const res = await fetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: JSON.stringify({
          sessionId: "http-sess-stream",
          message: "intake form review",
          draft: { pipeline: { id: "demo", stages: [] } },
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/ndjson/);
      const text = await res.text();
      const frames = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; sessionId?: string });
      expect(frames.some((f) => f.type === "delta" || f.type === "event")).toBe(
        true,
      );
      expect(frames.at(-1)?.type).toBe("done");
      expect(frames.at(-1)?.sessionId).toBe("http-sess-stream");
    });
  });

  it("posts draft each turn and keeps durable session across messages", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-chat-"));
      const { server, base } = await withServer(repo.root, storeRoot);
      cleanups.push(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      );
      await createSession(base, "http-sess-multi");

      const first = await jsonFetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "http-sess-multi",
          message: "intake form review",
          draft: { pipeline: { id: "demo", stages: [] } },
        }),
      });
      expect(first.status).toBe(200);
      expect(first.body.draft.pipeline.stages.length).toBe(1);

      const second = await jsonFetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "http-sess-multi",
          message: "thanks",
          draft: first.body.draft,
        }),
      });
      expect(second.status).toBe(200);
      expect(second.body.sessionId).toBe("http-sess-multi");
      expect(second.body.draft.pipeline.stages.length).toBe(1);
      expect(
        second.body.events.some(
          (e: { type: string; text?: string }) =>
            e.type === "message" && e.text === "Got it: thanks",
        ),
      ).toBe(true);

      const got = await jsonFetch(
        `${base}/api/workshop/sessions/http-sess-multi`,
      );
      expect(got.status).toBe(200);
      expect(got.body.session.title).toBe("intake form review");
      expect(got.body.session.transcript.length).toBeGreaterThanOrEqual(3);
    });
  });

  it("rejects missing message", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-chat-"));
      const { server, base } = await withServer(repo.root, storeRoot);
      cleanups.push(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      );
      await createSession(base, "http-sess-msg");
      const result = await jsonFetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "http-sess-msg",
          draft: { pipeline: { id: "demo", stages: [] } },
        }),
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/message/i);
    });
  });

  it("rejects missing sessionId", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-chat-"));
      const { server, base } = await withServer(repo.root, storeRoot);
      cleanups.push(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      );
      const result = await jsonFetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "hello",
          draft: { pipeline: { id: "demo", stages: [] } },
        }),
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/sessionId/i);
    });
  });

  it("returns 404 for unknown sessionId (no create-on-missing)", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-chat-"));
      const { server, base } = await withServer(repo.root, storeRoot);
      cleanups.push(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      );
      const result = await jsonFetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "does-not-exist",
          message: "hello",
          draft: { pipeline: { id: "demo", stages: [] } },
        }),
      });
      expect(result.status).toBe(404);
      expect(result.body.code).toBe("workshop_session_not_found");
    });
  });
});

describe("Workshop sessions HTTP API", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
    resetWorkshopChatSessionsForTests();
  });

  it("creates, lists, and gets sessions for History/New", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-sess-"));
      const { server, base } = await withServer(repo.root, storeRoot);
      cleanups.push(
        () =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      );

      const emptyList = await jsonFetch(`${base}/api/workshop/sessions`);
      expect(emptyList.status).toBe(200);
      expect(emptyList.body.sessions).toEqual([]);

      const created = await createSession(base);
      expect(created.status).toBe(201);
      expect(created.body.session.id).toBeTruthy();
      expect(created.body.session.title).toBe("");
      expect(created.body.session.transcript).toEqual([]);
      expect(created.body.session).not.toHaveProperty("draft");

      const listed = await jsonFetch(`${base}/api/workshop/sessions`);
      expect(listed.status).toBe(200);
      expect(listed.body.sessions).toHaveLength(1);
      expect(listed.body.sessions[0].id).toBe(created.body.session.id);

      const got = await jsonFetch(
        `${base}/api/workshop/sessions/${created.body.session.id}`,
      );
      expect(got.status).toBe(200);
      expect(got.body.session.id).toBe(created.body.session.id);

      const missing = await jsonFetch(
        `${base}/api/workshop/sessions/no-such-session`,
      );
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe("workshop_session_not_found");
    });
  });
});

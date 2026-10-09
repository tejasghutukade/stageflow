import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import {
  createWorkshopOperatorHost,
  type OperatorAgentModel,
} from "../src/operatorAgent/index.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { writeFactorySettings } from "../src/runtime/settingsFile.js";
import { readDraftFromContext } from "../src/operatorAgent/index.js";
import { resetWorkshopChatSessionsForTests } from "../src/workshop/chatTurn.js";
import {
  createWorkshopBuild,
  getWorkshopBuild,
} from "../src/workshop/buildStore.js";
import {
  getWorkshopSession,
  resolveWorkshopSessionStoreRoot,
  updateWorkshopSessionActiveBuildId,
} from "../src/workshop/sessionStore.js";
import { closeServer } from "./helpers/closeServer.js";
import {
  initTempGitRepo,
  withIsolatedHome,
} from "./helpers/projectContext.js";

async function jsonFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, headers: res.headers };
}

async function withServer(
  cwd: string,
  storeRoot: string,
  workshopOperatorHost?: ReturnType<typeof createWorkshopOperatorHost>,
) {
  const store = createRunStore({ rootDir: storeRoot });
  await store.ensureProject(cwd);
  const started = await startUiServer({
    agent: scriptedFakeAgent([]),
    cwd,
    rootDir: storeRoot,
    store,
    port: 0,
    uiDistDir: path.join(storeRoot, "missing-ui"),
    workshopOperatorHost:
      workshopOperatorHost ??
      createWorkshopOperatorHost([
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
      cleanups.push(() => closeServer(server));
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
      expect(result.headers.get("content-type")).toMatch(/json/);
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
      cleanups.push(() => closeServer(server));
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
      cleanups.push(() => closeServer(server));
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
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              sessionId?: string;
              event?: { type: string };
              draft?: { pipeline: { stages: unknown[] } };
            },
        );
      expect(
        frames.some((f) => f.type === "event" && f.event?.type === "proposal"),
      ).toBe(true);
      expect(frames.filter((f) => f.type === "done")).toHaveLength(1);
      expect(frames.at(-1)?.type).toBe("done");
      expect(frames.at(-1)?.draft?.pipeline.stages).toHaveLength(1);
      expect(frames.at(-1)?.sessionId).toBe("http-sess-stream");
    });
  });

  it("POST /api/workshop/chat/stop aborts the in-flight turn", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-chat-"));
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let completeEntered = false;
      const model: OperatorAgentModel = {
        async complete() {
          completeEntered = true;
          await gate;
          return {
            events: [
              { type: "message", role: "assistant", text: "stopped" },
            ],
          };
        },
        async abort() {
          release();
        },
      };
      const { server, base } = await withServer(
        repo.root,
        storeRoot,
        createWorkshopOperatorHost({ model }),
      );
      cleanups.push(() => closeServer(server));
      await createSession(base, "http-sess-stop");
      const idle = await jsonFetch(`${base}/api/workshop/chat/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "http-sess-stop" }),
      });
      expect(idle.status).toBe(200);
      expect(idle.body.stopped).toBe(false);

      const resPromise = fetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: JSON.stringify({
          sessionId: "http-sess-stop",
          message: "hello",
          draft: { pipeline: { id: "demo", stages: [] } },
          stream: true,
        }),
      });
      for (let i = 0; i < 40 && !completeEntered; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(completeEntered).toBe(true);
      const stop = await jsonFetch(`${base}/api/workshop/chat/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: "http-sess-stop" }),
      });
      expect(stop.status).toBe(200);
      expect(stop.body.stopped).toBe(true);
      expect(stop.body.draft?.pipeline?.id).toBe("demo");
      const res = await resPromise;
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('"type":"done"');
    });
  });

  it("flushes ≥2 mid-turn NDJSON delta frames before done", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-chat-"));
      const model: OperatorAgentModel = {
        async complete({ onDelta }) {
          onDelta?.("alpha-");
          await new Promise((r) => setTimeout(r, 25));
          onDelta?.("beta");
          await new Promise((r) => setTimeout(r, 25));
          return {
            events: [
              { type: "message", role: "assistant", text: "alpha-beta" },
            ],
          };
        },
      };
      const { server, base } = await withServer(
        repo.root,
        storeRoot,
        createWorkshopOperatorHost({ model }),
      );
      cleanups.push(() => closeServer(server));
      await createSession(base, "http-sess-mid");
      const res = await fetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: JSON.stringify({
          sessionId: "http-sess-mid",
          message: "stream please",
          draft: { pipeline: { id: "demo", stages: [] } },
          stream: true,
        }),
      });
      expect(res.status).toBe(200);
      expect(res.body).toBeTruthy();
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const frames: Array<{ type: string; text?: string }> = [];
      let sawTwoDeltasBeforeDone = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const frame = JSON.parse(line) as { type: string; text?: string };
          frames.push(frame);
          const deltaCount = frames.filter((f) => f.type === "delta").length;
          if (deltaCount >= 2 && !frames.some((f) => f.type === "done")) {
            sawTwoDeltasBeforeDone = true;
          }
        }
      }
      if (buffer.trim()) {
        frames.push(JSON.parse(buffer.trim()) as { type: string; text?: string });
      }
      expect(frames.filter((f) => f.type === "delta").map((f) => f.text)).toEqual([
        "alpha-",
        "beta",
      ]);
      expect(sawTwoDeltasBeforeDone).toBe(true);
      expect(frames.at(-1)?.type).toBe("done");
      // Mid-turn path skips duplicate post-hoc chunking of the same text.
      expect(frames.filter((f) => f.type === "delta")).toHaveLength(2);
    });
  });

  it("emits an error event frame when the mid-stream turn fails", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-chat-"));
      const model: OperatorAgentModel = {
        async complete({ onDelta }) {
          onDelta?.("partial");
          throw new Error("model exploded mid-turn");
        },
      };
      const { server, base } = await withServer(
        repo.root,
        storeRoot,
        createWorkshopOperatorHost({ model }),
      );
      cleanups.push(() => closeServer(server));
      await createSession(base, "http-sess-err");
      const res = await fetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: JSON.stringify({
          sessionId: "http-sess-err",
          message: "boom",
          draft: { pipeline: { id: "demo", stages: [] } },
          stream: true,
        }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const frames = text
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              text?: string;
              event?: { type: string; message?: string };
            },
        );
      expect(frames.some((f) => f.type === "delta" && f.text === "partial")).toBe(
        true,
      );
      expect(
        frames.some(
          (f) =>
            f.type === "event" &&
            f.event?.type === "error" &&
            typeof f.event.message === "string" &&
            /model exploded mid-turn/i.test(f.event.message),
        ),
      ).toBe(true);
      const done = frames.at(-1) as {
        type: string;
        sessionId?: string;
        events?: Array<{ type: string; message?: string }>;
        pending?: unknown;
        autoApply?: boolean;
        model?: string;
        draft?: { pipeline?: { id?: string } };
      };
      expect(done?.type).toBe("done");
      expect(done.sessionId).toBe("http-sess-err");
      expect(done.pending).toBeNull();
      expect(done.autoApply).toBe(false);
      expect(typeof done.model).toBe("string");
      expect(done.draft?.pipeline?.id).toBe("demo");
      expect(
        done.events?.some(
          (e) =>
            e.type === "error" &&
            typeof e.message === "string" &&
            /model exploded mid-turn/i.test(e.message),
        ),
      ).toBe(true);
    });
  });

  it("posts draft each turn and keeps durable session across messages", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-chat-"));
      const { server, base } = await withServer(repo.root, storeRoot);
      cleanups.push(() => closeServer(server));
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

  it.each([
    { missing: "message", body: { sessionId: "http-sess-missing" }, error: /message/i },
    { missing: "sessionId", body: { message: "hello" }, error: /sessionId/i },
  ])("rejects a body missing $missing", async ({ body, error }) => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-chat-"));
      const { server, base } = await withServer(repo.root, storeRoot);
      cleanups.push(() => closeServer(server));
      await createSession(base, "http-sess-missing");
      const result = await jsonFetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...body,
          draft: { pipeline: { id: "demo", stages: [] } },
        }),
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(error);
    });
  });

  it("returns 404 for unknown sessionId (no create-on-missing)", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-chat-"));
      const { server, base } = await withServer(repo.root, storeRoot);
      cleanups.push(() => closeServer(server));
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

  it("edits the pinned build when the request body carries a different draft", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-chat-"));
      const home = resolveWorkshopSessionStoreRoot();
      const { server, base } = await withServer(repo.root, storeRoot);
      cleanups.push(() => closeServer(server));
      await createSession(base, "http-pin-a");
      createWorkshopBuild(home, {
        id: "build-a",
        draft: { pipeline: { id: "alpha", stages: [] } },
      });
      updateWorkshopSessionActiveBuildId(home, "http-pin-a", "build-a");

      const result = await jsonFetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "http-pin-a",
          message: "intake form review",
          draft: { pipeline: { id: "other", stages: [] } },
        }),
      });
      expect(result.status).toBe(200);
      expect(result.body.buildId).toBe("build-a");
      expect(result.body.draft.pipeline.id).toBe("alpha");
      expect(result.body.draft.pipeline.stages.length).toBe(1);
      const stored = getWorkshopBuild(home, "build-a");
      expect(stored.id).toBe("build-a");
      expect(stored.draft.pipeline.id).toBe("alpha");
      expect(stored.draft.pipeline.stages.length).toBe(1);
    });
  });

  it("names the pinned build id on an activity frame", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-chat-"));
      const home = resolveWorkshopSessionStoreRoot();
      const model: OperatorAgentModel = {
        async complete({ onActivity }) {
          onActivity?.({
            id: "act-1",
            name: "edit_pipeline",
            status: "running",
          });
          return {
            events: [
              { type: "message", role: "assistant", text: "working" },
            ],
          };
        },
      };
      const { server, base } = await withServer(
        repo.root,
        storeRoot,
        createWorkshopOperatorHost({ model }),
      );
      cleanups.push(() => closeServer(server));
      await createSession(base, "http-pin-activity");
      createWorkshopBuild(home, {
        id: "build-act",
        draft: { pipeline: { id: "alpha", stages: [] } },
      });
      updateWorkshopSessionActiveBuildId(home, "http-pin-activity", "build-act");

      const res = await fetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: JSON.stringify({
          sessionId: "http-pin-activity",
          message: "edit the open pipeline",
          draft: { pipeline: { id: "other", stages: [] } },
          stream: true,
        }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      const frames = text
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              type: string;
              buildId?: string;
              name?: string;
            },
        );
      const activity = frames.find((frame) => frame.type === "activity");
      expect(activity?.name).toBe("edit_pipeline");
      expect(activity?.buildId).toBe("build-act");
      const done = frames.at(-1);
      expect(done?.type).toBe("done");
      expect(done?.buildId).toBe("build-act");
    });
  });

  it("a second chat post waits, then runs on the pointer", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-chat-"));
      const home = resolveWorkshopSessionStoreRoot();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered = false;
      const seen: string[] = [];
      const model: OperatorAgentModel = {
        async complete({ tools }) {
          const id = readDraftFromContext(tools.getContext()).pipeline.id;
          if (!entered) {
            seen.push(id);
            entered = true;
            await gate;
            seen.push(readDraftFromContext(tools.getContext()).pipeline.id);
            return {
              events: [
                { type: "message", role: "assistant", text: "first" },
              ],
            };
          }
          seen.push(id);
          return {
            events: [
              { type: "message", role: "assistant", text: "second" },
            ],
          };
        },
      };
      const { server, base } = await withServer(
        repo.root,
        storeRoot,
        createWorkshopOperatorHost({ model }),
      );
      cleanups.push(() => closeServer(server));
      await createSession(base, "http-pin-wait");
      createWorkshopBuild(home, {
        id: "build-a",
        draft: { pipeline: { id: "alpha", stages: [] } },
      });
      createWorkshopBuild(home, {
        id: "build-b",
        draft: { pipeline: { id: "beta", stages: [] } },
      });
      updateWorkshopSessionActiveBuildId(home, "http-pin-wait", "build-a");

      const firstPromise = jsonFetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "http-pin-wait",
          message: "first",
          draft: { pipeline: { id: "posted", stages: [] } },
        }),
      });
      for (let i = 0; i < 40 && !entered; i += 1) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(entered).toBe(true);
      updateWorkshopSessionActiveBuildId(home, "http-pin-wait", "build-b");
      const secondPromise = jsonFetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "http-pin-wait",
          message: "second",
          draft: { pipeline: { id: "hijack", stages: [] } },
        }),
      });
      await new Promise((r) => setTimeout(r, 80));
      release();
      const first = await firstPromise;
      const second = await secondPromise;
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(seen).toEqual(["alpha", "alpha", "beta"]);
      expect(first.body.draft.pipeline.id).toBe("alpha");
      expect(second.body.draft.pipeline.id).toBe("beta");
      expect(getWorkshopSession(home, "http-pin-wait").activeBuildId).toBe(
        "build-b",
      );
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
      cleanups.push(() => closeServer(server));

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

  it("soft-undos a mutation via POST /sessions/:id/undo", async () => {
    await withIsolatedHome(async () => {
      const repo = await initTempGitRepo();
      cleanups.push(repo.cleanup);
      const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-undo-"));
      const { server, base } = await withServer(repo.root, storeRoot);
      cleanups.push(() => closeServer(server));

      const created = await createSession(base, "http-sess-undo");
      expect(created.status).toBe(201);

      const chat = await jsonFetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "http-sess-undo",
          message: "intake form review",
          draft: { pipeline: { id: "demo", stages: [] } },
        }),
      });
      expect(chat.status).toBe(200);
      expect(chat.body.draft.pipeline.stages.length).toBe(1);
      const mutationId = chat.body.pending?.id as string;
      expect(mutationId).toBeTruthy();

      const undone = await jsonFetch(
        `${base}/api/workshop/sessions/http-sess-undo/undo`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mutationId,
            draft: chat.body.draft,
          }),
        },
      );
      expect(undone.status).toBe(200);
      expect(undone.body.ok).toBe(true);
      expect(undone.body.draft.pipeline.stages).toEqual([]);
    });
  });
});

describe("POST /api/workshop/chat attachments and context", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
    resetWorkshopChatSessionsForTests();
  });

  async function withCapturingServer() {
    const repo = await initTempGitRepo();
    cleanups.push(repo.cleanup);
    const storeRoot = await mkdtemp(path.join(tmpdir(), "sf-workshop-attach-"));
    const prompts: string[] = [];
    const model: OperatorAgentModel = {
      async complete({ message }) {
        prompts.push(message);
        return {
          events: [{ type: "message", role: "assistant", text: "noted" }],
        };
      },
    };
    const { server, base } = await withServer(
      repo.root,
      storeRoot,
      createWorkshopOperatorHost({ model }),
    );
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    );
    return { base, prompts };
  }

  function chatBody(sessionId: string, extra: Record<string, unknown>) {
    return JSON.stringify({
      sessionId,
      message: "use the attached notes",
      draft: { pipeline: { id: "demo", stages: [] } },
      ...extra,
    });
  }

  it("rejects invalid attachments with workshop_attachment_invalid", async () => {
    await withIsolatedHome(async () => {
      const { base, prompts } = await withCapturingServer();
      await createSession(base, "attach-invalid");
      const file = { name: "a.md", mediaType: "text/markdown", size: 1, content: "x" };
      const cases: unknown[] = [
        "not-an-array",
        Array.from({ length: 6 }, (_, i) => ({ ...file, name: `f${i}.md` })),
        [{ ...file, content: 42 }],
        [{ ...file, name: "" }],
        [{ ...file, content: "x".repeat(256 * 1024 + 1) }],
      ];
      for (const attachments of cases) {
        const result = await jsonFetch(`${base}/api/workshop/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: chatBody("attach-invalid", { attachments }),
        });
        expect(result.status).toBe(400);
        expect(result.body.code).toBe("workshop_attachment_invalid");
        expect(typeof result.body.error).toBe("string");
      }
      expect(prompts).toEqual([]);
    });
  });

  it("injects attachments into the agent prompt and stores only metadata", async () => {
    await withIsolatedHome(async () => {
      const { base, prompts } = await withCapturingServer();
      await createSession(base, "attach-json");
      const content = "# Release notes\n```yaml\nid: x\n```\n";
      const result = await jsonFetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody("attach-json", {
          attachments: [
            { name: "notes.md", mediaType: "text/markdown", size: 999, content },
          ],
        }),
      });
      expect(result.status).toBe(200);
      expect(prompts).toHaveLength(1);
      const prompt = prompts[0]!;
      expect(prompt.startsWith("use the attached notes")).toBe(true);
      expect(prompt).toContain("Attached file: notes.md\n````\n");
      expect(prompt).toContain(content);
      expect(prompt).not.toContain("YAML authoring reference");

      const session = getWorkshopSession(
        resolveWorkshopSessionStoreRoot(),
        "attach-json",
      );
      const user = session.transcript.find((m) => m.role === "user");
      expect(user?.text).toBe("use the attached notes");
      expect(user?.attachments).toEqual([
        {
          name: "notes.md",
          size: Buffer.byteLength(content, "utf8"),
          mediaType: "text/markdown",
        },
      ]);
      expect(JSON.stringify(session)).not.toContain("Release notes");

      const got = await jsonFetch(`${base}/api/workshop/sessions/attach-json`);
      expect(got.body.session.transcript[0].attachments[0].name).toBe("notes.md");
    });
  });

  it("injects attachments and docs on the NDJSON path and echoes autoApply", async () => {
    await withIsolatedHome(async () => {
      const { base, prompts } = await withCapturingServer();
      await createSession(base, "attach-stream");
      const res = await fetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        body: chatBody("attach-stream", {
          stream: true,
          autoApply: true,
          context: { docs: true },
          attachments: [
            { name: "spec.txt", mediaType: "text/plain", size: 5, content: "hello" },
          ],
        }),
      });
      expect(res.status).toBe(200);
      const frames = (await res.text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; autoApply?: boolean });
      expect(frames.at(-1)?.type).toBe("done");
      expect(frames.at(-1)?.autoApply).toBe(true);
      const prompt = prompts[0]!;
      expect(prompt).toContain("Attached file: spec.txt\n```\nhello\n```");
      expect(prompt).toContain(
        "Stageflow YAML authoring reference (docs/yaml-catalog.md):",
      );
      expect(prompt).toContain("# YAML catalog");
      expect(prompt.indexOf("spec.txt")).toBeLessThan(
        prompt.indexOf("YAML authoring reference"),
      );
    });
  });

  it("echoes autoApply on JSON turns", async () => {
    await withIsolatedHome(async () => {
      const { base } = await withCapturingServer();
      await createSession(base, "auto-apply-echo");
      const on = await jsonFetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody("auto-apply-echo", { autoApply: true }),
      });
      expect(on.status).toBe(200);
      expect(on.body.autoApply).toBe(true);
      const off = await jsonFetch(`${base}/api/workshop/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: chatBody("auto-apply-echo", {}),
      });
      expect(off.body.autoApply).toBe(false);
    });
  });
});

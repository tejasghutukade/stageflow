import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scriptedFakeAgent } from "../src/agent/fakeAgent.js";
import { createWorkshopOperatorHost } from "../src/operatorAgent/index.js";
import { createRunStore } from "../src/runstore/createStore.js";
import { startUiServer } from "../src/server/http.js";
import { writeFactorySettings } from "../src/runtime/settingsFile.js";
import { initTempGitRepo } from "./helpers/projectContext.js";

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
    ]),
  });
  const addr = started.server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("expected TCP listen address");
  }
  const base = `http://127.0.0.1:${addr.port}`;
  return { server: started.server, base, store };
}

describe("POST /api/workshop/chat", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("runs Operator Agent Host and returns proposal + resolved model", async () => {
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
    const result = await jsonFetch(`${base}/api/workshop/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "intake form review",
        draft: { pipeline: { id: "demo", stages: [] } },
        autoApply: false,
      }),
    });
    expect(result.status).toBe(200);
    expect(result.body.model).toBe("openai/gpt-5");
    expect(result.body.pending?.summary).toMatch(/Add stage/i);
    expect(
      result.body.events.some((e: { type: string }) => e.type === "proposal"),
    ).toBe(true);
    expect(result.body.draft.pipeline.stages.length).toBe(1);
    expect(result.body.pending?.nextDraft.pipeline.stages.length).toBe(1);
  });

  it("prefers session model override over settings default", async () => {
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
    const result = await jsonFetch(`${base}/api/workshop/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "intake form review",
        draft: { pipeline: { id: "demo", stages: [] } },
        model: "anthropic/claude-sonnet-4-5",
      }),
    });
    expect(result.status).toBe(200);
    expect(result.body.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("streams NDJSON frames when Accept requests ndjson", async () => {
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
    const res = await fetch(`${base}/api/workshop/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/x-ndjson",
      },
      body: JSON.stringify({
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
      .map((line) => JSON.parse(line) as { type: string });
    expect(frames.some((f) => f.type === "delta" || f.type === "event")).toBe(
      true,
    );
    expect(frames.at(-1)?.type).toBe("done");
  });

  it("rejects missing message", async () => {
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
        draft: { pipeline: { id: "demo", stages: [] } },
      }),
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/message/i);
  });
});

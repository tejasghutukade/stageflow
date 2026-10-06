import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { AgentCard, Role, type Message, type Task } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { createA2aHost, type A2aRuntime } from "../src/a2a/server.js";
import { RateLimiter } from "../src/a2a/limits.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { RunManager } from "../src/runtime/runManager.js";
import type { AgentPort } from "../src/agent/port.js";
import { supplierAgent } from "./fixtures/a2a/agents.js";

const env = { PROCUREMENT_TOKEN: "p".repeat(40), OTHER_TOKEN: "o".repeat(40) };
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});

async function host(agent: AgentPort = supplierAgent()) {
  const configPath = path.resolve("tests/fixtures/a2a/a2a.yaml");
  const root = await mkdtemp(path.join(tmpdir(), "sf-a2a-limits-"));
  roots.push(root);
  const { store, connection } = createRunStoreWithConnection({ rootDir: root });
  const manager = new RunManager({ agent, store, cwd: root });
  const runtime: A2aRuntime = { manager, runStore: store, rootDir: root, connection };
  const a2a = await createA2aHost(runtime, configPath, env);
  const server = createServer(async (req, res) => {
    if (!(await a2a.handle(req, res, new URL(req.url!, "http://localhost").pathname))) {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  return { a2a, root, url: `http://127.0.0.1:${address.port}` };
}

async function clientFor(url: string, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const authenticatedFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } });
  const card = AgentCard.fromJSON(await (await fetch(`${url}/.well-known/agent-card.json`, { headers })).json());
  card.supportedInterfaces[0].url = `${url}/a2a`;
  return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: authenticatedFetch })] }).createFromAgentCard(card);
}

function invokeMessage(supplier: string): Message {
  return {
    messageId: "m-" + Math.random().toString(36).slice(2),
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts: [{ content: { $case: "data", value: { contractVersion: 1, operation: "invoke", capability: "supplier_assessment", input: { supplier } } }, metadata: undefined, filename: "", mediaType: "application/json" }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

async function waitForState(client: Awaited<ReturnType<typeof clientFor>>, taskId: string, states: number[]): Promise<Task> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const task = (await client.getTask({ tenant: "", id: taskId, historyLength: undefined })) as Task;
    if (states.includes(task.status.state)) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for task state");
}

describe("RateLimiter", () => {
  it("allows a burst then throttles until it refills, per key", () => {
    let now = 0;
    const limiter = new RateLimiter(3, 60, () => now);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
    expect(limiter.tryConsume("b")).toBe(true);
    now += 60_000;
    expect(limiter.tryConsume("a")).toBe(true);
  });
});

describe("A2A admission and retention", () => {
  it("rejects a new invocation once the per-caller nonterminal cap is reached", async () => {
    const { url } = await host();
    const client = await clientFor(url, env.PROCUREMENT_TOKEN);
    const first = (await client.sendMessage({ tenant: "", message: invokeMessage("Supplier A"), configuration: undefined, metadata: undefined })) as Task;
    const second = (await client.sendMessage({ tenant: "", message: invokeMessage("Supplier B"), configuration: undefined, metadata: undefined })) as Task;
    expect(first.id).not.toBe(second.id);
    await expect(
      client.sendMessage({ tenant: "", message: invokeMessage("Supplier C"), configuration: undefined, metadata: undefined }),
    ).rejects.toThrow(/Too many active tasks/);
  });

  it("prunes terminal tasks and their frozen artifacts past the retention window", async () => {
    const { a2a, root, url } = await host(supplierAgent());
    const client = await clientFor(url, env.PROCUREMENT_TOKEN);
    const sent = (await client.sendMessage({ tenant: "", message: invokeMessage("Supplier A"), configuration: undefined, metadata: undefined })) as Task;
    const inputRequired = await waitForState(client, sent.id, [6]);
    const questionsPart = inputRequired.status.message!.parts[0].content as { $case: "data"; value: { questions: Array<{ handle: string }> } };
    const handle = questionsPart.value.questions[0].handle;
    const answerMessage: Message = {
      messageId: "m-answer",
      contextId: "",
      taskId: sent.id,
      role: Role.ROLE_USER,
      parts: [{ content: { $case: "data", value: { contractVersion: 1, operation: "answer", prompt: handle, answer: { kind: "free_text", text: "Yes." } } }, metadata: undefined, filename: "", mediaType: "application/json" }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    };
    await client.sendMessage({ tenant: "", message: answerMessage, configuration: undefined, metadata: undefined });
    const completed = await waitForState(client, sent.id, [3, 4]);
    expect(completed.status.state).toBe(3);
    const artifact = completed.artifacts.find((entry) => entry.name === "assessment.md")!;
    const contentPath = (
      new Database(path.join(storeRootFor(root), "state.db"))
    ).prepare("SELECT content_path FROM a2a_artifacts WHERE artifact_id = ?").get(artifact.artifactId) as { content_path: string };

    const db = new Database(path.join(storeRootFor(root), "state.db"));
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE a2a_tasks SET updated_at = ? WHERE task_id = ?").run(old, sent.id);
    db.prepare("UPDATE a2a_messages SET created_at = ? WHERE task_id = ?").run(old, sent.id);
    db.close();

    const result = await a2a.pruneExpired(new Date());
    expect(result.removedTasks).toBe(1);

    await expect(client.getTask({ tenant: "", id: sent.id, historyLength: undefined })).rejects.toThrow();
    const { existsSync } = await import("node:fs");
    expect(existsSync(contentPath.content_path)).toBe(false);
  });
});

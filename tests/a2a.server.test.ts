import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentCard, Role, type Message, type Task } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { createA2aHost, A2A_BODY_LIMIT, type A2aRuntime } from "../src/a2a/server.js";
import { encodePromptHandle } from "../src/a2a/contracts.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { RunManager } from "../src/runtime/runManager.js";
import type { AgentPort } from "../src/agent/port.js";
import { supplierAgent, gatedAgent } from "./fixtures/a2a/agents.js";

const env = { PROCUREMENT_TOKEN: "p".repeat(40), OTHER_TOKEN: "o".repeat(40) };
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
});

async function host(configPath: string, agent: AgentPort = supplierAgent()) {
  const root = await mkdtemp(path.join(tmpdir(), "sf-a2a-server-"));
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
  return { a2a, manager, store, url: `http://127.0.0.1:${address.port}` };
}

async function clientFor(url: string, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const authenticatedFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } });
  const cardResponse = await fetch(`${url}/.well-known/agent-card.json`, { headers });
  const card = AgentCard.fromJSON(await cardResponse.json());
  card.supportedInterfaces[0].url = `${url}/a2a`;
  return new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: authenticatedFetch })] }).createFromAgentCard(card);
}

function dataMessage(taskId: string, value: unknown): Message {
  return {
    messageId: "m-" + Math.random().toString(36).slice(2),
    contextId: "",
    taskId,
    role: Role.ROLE_USER,
    parts: [{ content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function invokeMessage(capability: string, input: unknown, messageId?: string): Message {
  const message = dataMessage("", { contractVersion: 1, operation: "invoke", capability, input });
  return messageId ? { ...message, messageId } : message;
}

async function waitForState(client: Awaited<ReturnType<typeof clientFor>>, taskId: string, states: number[]): Promise<Task> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const task = (await client.getTask({ tenant: "", id: taskId, historyLength: undefined })) as Task;
    if (states.includes(task.status.state)) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for task state");
}

const supplierConfig = path.resolve("tests/fixtures/a2a/a2a.yaml");
const gatedConfig = path.resolve("tests/fixtures/a2a/gated.yaml");

describe("A2A invocation", () => {
  it("runs a supplier assessment end to end: clarify, complete, download", async () => {
    const { url } = await host(supplierConfig);
    const client = await clientFor(url, env.PROCUREMENT_TOKEN);

    const sent = (await client.sendMessage({
      tenant: "",
      message: invokeMessage("supplier_assessment", { supplier: "Northstar Packaging" }),
      configuration: undefined,
      metadata: undefined,
    })) as Task;
    const inputRequired = await waitForState(client, sent.id, [6]); // TASK_STATE_INPUT_REQUIRED
    const questionsPart = inputRequired.status.message!.parts[0].content as { $case: "data"; value: { questions: Array<{ handle: string; message: string }> } };
    const handle = questionsPart.value.questions[0].handle;
    expect(questionsPart.value.questions[0].message).toContain("certification");

    const answered = (await client.sendMessage({
      tenant: "",
      message: dataMessage(sent.id, { contractVersion: 1, operation: "answer", prompt: handle, answer: { kind: "free_text", text: "Yes, mandatory." } }),
      configuration: undefined,
      metadata: undefined,
    })) as Task;
    const completed = answered.status.state === 3 ? answered : await waitForState(client, sent.id, [3, 4]);
    expect(completed.status.state).toBe(3); // TASK_STATE_COMPLETED
    expect(completed.artifacts.map((a) => a.name).sort()).toEqual(["assessment.md", "result"].sort());
    const resultArtifact = completed.artifacts.find((a) => a.artifactId === "result")!;
    const payloadPart = resultArtifact.parts[0].content as { $case: "data"; value: { recommendation: string } };
    expect(payloadPart.value.recommendation).toBe("approve");

    const fileArtifact = completed.artifacts.find((a) => a.name === "assessment.md")!;
    const urlPartContent = fileArtifact.parts[0].content as { $case: "url"; value: string };
    const localArtifactUrl = url + new URL(urlPartContent.value).pathname;
    const download = await fetch(localArtifactUrl, { headers: { authorization: `Bearer ${env.PROCUREMENT_TOKEN}` } });
    expect(await download.text()).toContain("approved");

    const fetched = (await client.getTask({ tenant: "", id: sent.id, historyLength: undefined })) as Task;
    expect(fetched.status.state).toBe(3);

    const listed = await client.listTasks({ tenant: "", contextId: "", status: 0 as never, pageSize: undefined, pageToken: "", historyLength: undefined, statusTimestampAfter: undefined, includeArtifacts: undefined });
    expect(listed.tasks.map((t) => t.id)).toContain(sent.id);
  });

  it("deduplicates identical resubmissions and rejects conflicting reuse of the same message id", async () => {
    const { url } = await host(supplierConfig);
    const client = await clientFor(url, env.PROCUREMENT_TOKEN);
    const message = invokeMessage("supplier_assessment", { supplier: "Northstar Packaging" }, "m-fixed");
    const first = (await client.sendMessage({ tenant: "", message, configuration: undefined, metadata: undefined })) as Task;
    const second = (await client.sendMessage({ tenant: "", message, configuration: undefined, metadata: undefined })) as Task;
    expect(second.id).toBe(first.id);
    const conflicting = invokeMessage("supplier_assessment", { supplier: "Different Co" }, "m-fixed");
    await expect(
      client.sendMessage({ tenant: "", message: conflicting, configuration: undefined, metadata: undefined }),
    ).rejects.toThrow(/already used/);
  });

  it("rejects unknown capabilities and invalid input before starting a run", async () => {
    const { url, manager } = await host(supplierConfig);
    const client = await clientFor(url, env.PROCUREMENT_TOKEN);
    await expect(
      client.sendMessage({ tenant: "", message: invokeMessage("does_not_exist", {}), configuration: undefined, metadata: undefined }),
    ).rejects.toThrow(/Unknown capability/);
    await expect(
      client.sendMessage({ tenant: "", message: invokeMessage("supplier_assessment", {}), configuration: undefined, metadata: undefined }),
    ).rejects.toThrow();
    expect(manager.getActiveCount()).toBe(0);
  });

  it("isolates tasks between callers", async () => {
    const { url } = await host(supplierConfig);
    const procurement = await clientFor(url, env.PROCUREMENT_TOKEN);
    const sent = (await procurement.sendMessage({
      tenant: "",
      message: invokeMessage("supplier_assessment", { supplier: "Northstar Packaging" }),
      configuration: undefined,
      metadata: undefined,
    })) as Task;
    const other = await clientFor(url, env.OTHER_TOKEN);
    await expect(other.getTask({ tenant: "", id: sent.id, historyLength: undefined })).rejects.toThrow();
  });

  it("reports tasks as non-cancelable rather than pretending to cancel", async () => {
    const { url } = await host(supplierConfig);
    const client = await clientFor(url, env.PROCUREMENT_TOKEN);
    const sent = (await client.sendMessage({
      tenant: "",
      message: invokeMessage("supplier_assessment", { supplier: "Northstar Packaging" }),
      configuration: undefined,
      metadata: undefined,
    })) as Task;
    await expect(client.cancelTask({ tenant: "", id: sent.id, metadata: undefined })).rejects.toThrow();
  });

  it("never lets a caller answer an operator-only gate, even with a forged handle", async () => {
    const { url } = await host(gatedConfig, gatedAgent());
    const client = await clientFor(url, env.PROCUREMENT_TOKEN);
    const sent = (await client.sendMessage({
      tenant: "",
      message: invokeMessage("gated_capability", { note: "please approve" }),
      configuration: undefined,
      metadata: undefined,
    })) as Task;
    await waitForState(client, sent.id, [2]); // TASK_STATE_WORKING (operator wait, not input-required)
    const forgedHandle = encodePromptHandle(sent.id, "approve", "whatever");
    await expect(
      client.sendMessage({
        tenant: "",
        message: dataMessage(sent.id, { contractVersion: 1, operation: "answer", prompt: forgedHandle, answer: { kind: "free_text", text: "yes" } }),
        configuration: undefined,
        metadata: undefined,
      }),
    ).rejects.toThrow(/cannot be answered/);
  });

  it("fails closed on invalid configuration and enforces transport limits", async () => {
    const { a2a, url } = await host("/missing/private/a2a.yaml");
    expect(a2a.status.state).toBe("configuration_error");
    const headers = { authorization: `Bearer ${env.PROCUREMENT_TOKEN}` };
    expect((await fetch(`${url}/a2a`, { headers })).status).toBe(503);
    const { url: url2 } = await host(supplierConfig);
    expect((await fetch(`${url2}/a2a`, { headers })).status).toBe(405);
    expect((await fetch(`${url2}/a2a`, { method: "POST", headers, body: "{}" })).status).toBe(415);
    expect(
      (await fetch(`${url2}/a2a`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "x".repeat(A2A_BODY_LIMIT + 1) })).status,
    ).toBe(413);
    expect((await fetch(`${url2}/.well-known/agent-card.json`)).status).toBe(401);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { parse, stringify } from "yaml";
import { AgentCard, Role, type Message, type Task } from "@a2a-js/sdk";
import { ClientFactory, JsonRpcTransportFactory } from "@a2a-js/sdk/client";
import { A2aManagement } from "../src/a2a/management.js";
import { A2A_CALLER_STORE_PREFIX, loadPublicationRegistry, tokenDigestHex } from "../src/a2a/registry.js";
import { a2aWriteTargetPath, hostA2aConfigFile, resolveA2aConfigPath } from "../src/a2a/configDiscovery.js";
import { createA2aHost, type A2aHost } from "../src/a2a/server.js";
import { A2aStore } from "../src/a2a/store.js";
import { ChannelSecretStore } from "../src/channels/secretStore.js";
import { runA2aCommand } from "../src/cli/a2aCommand.js";
import { createRunStoreWithConnection } from "../src/runstore/createStore.js";
import { storeRootFor } from "../src/runstore/paths.js";
import { createBackup } from "../src/runstore/backup.js";
import { RunManager } from "../src/runtime/runManager.js";
import { handleA2aRoutes } from "../src/server/a2aRoutes.js";
import { supplierAgent } from "./fixtures/a2a/agents.js";

const fixture = path.resolve("tests/fixtures/a2a");
const roots: string[] = [];
const servers: Server[] = [];
const bodies: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  bodies.length = 0;
});

const publicationBody = (root: string, overrides: Record<string, unknown> = {}) => ({
  id: "supplier_assessment",
  name: "Assess a supplier",
  description: "Research a supplier against purchasing requirements.",
  project_root: root,
  pipeline: "supplier.pipeline.yaml",
  goal: "Produce an evidence-backed supplier assessment.",
  allowed_callers: [],
  input_schema: "supplier.schema.json",
  results: { stage: "final_report", include_payload: true, artifacts: ["assessment.md"] },
  caller_answerable_stages: ["clarify"],
  ...overrides,
});

async function setup(options: { env?: NodeJS.ProcessEnv } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "sf-a2a-management-"));
  roots.push(base);
  const project = path.join(base, "project");
  await cp(fixture, project, { recursive: true });
  const projectRoot = await realpath(project);
  const storeRoot = path.join(base, "store");
  const { store, connection } = createRunStoreWithConnection({ rootDir: storeRoot });
  await store.ensureProject(projectRoot);
  const manager = new RunManager({ agent: supplierAgent(), store, cwd: base });
  const secrets = new ChannelSecretStore(path.join(base, "creds", "channel-secrets.json"));
  const env = { STAGEFLOW_PUBLIC_URL: "https://ws.stage-flow.dev", ...options.env };
  const configFile = path.join(base, "home", "a2a.yaml");
  const host = await createA2aHost({ manager, runStore: store, rootDir: storeRoot, connection }, undefined, env, secrets);
  const management = new A2aManagement({ host, secrets, store, env, configPath: () => configFile });
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url!, "http://localhost").pathname;
    const json = (response: typeof res, status: number, body: unknown) => {
      const text = JSON.stringify(body);
      bodies.push(text);
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(text);
    };
    if (pathname === "/api/a2a/status") return json(res, 200, host.status);
    if (await handleA2aRoutes(req, req.method ?? "GET", pathname, management, res, json)) return;
    if (await host.handle(req, res, pathname)) return;
    res.writeHead(404);
    res.end();
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const url = `http://127.0.0.1:${address.port}`;
  const api = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(url + route, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as any };
  };
  return { base, project: projectRoot, store, connection, storeRoot, secrets, host, management, configFile, url, api, env };
}

async function agentCardStatus(url: string, token: string): Promise<number> {
  return (await fetch(`${url}/.well-known/agent-card.json`, { headers: { authorization: `Bearer ${token}` } })).status;
}

async function clientFor(url: string, token: string) {
  const headers = { authorization: `Bearer ${token}` };
  const authenticatedFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } });
  const card = AgentCard.fromJSON(await (await fetch(`${url}/.well-known/agent-card.json`, { headers })).json());
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

async function waitForState(client: Awaited<ReturnType<typeof clientFor>>, taskId: string, states: number[]): Promise<Task> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = (await client.getTask({ tenant: "", id: taskId, historyLength: undefined })) as Task;
    if (states.includes(task.status.state)) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for task state");
}

async function startTask(client: Awaited<ReturnType<typeof clientFor>>): Promise<Task> {
  return (await client.sendMessage({
    tenant: "",
    message: dataMessage("", { contractVersion: 1, operation: "invoke", capability: "supplier_assessment", input: { supplier: "Northstar Packaging" } }),
    configuration: undefined,
    metadata: undefined,
  })) as Task;
}

describe("A2A management API", () => {
  it("turns A2A on with no callers or publications, then adds a caller whose token works without a restart", async () => {
    const { api, url, host, configFile } = await setup();
    expect(host.status.state).toBe("disabled");
    expect((await api("GET", "/api/a2a/callers")).body).toEqual({ callers: [] });
    expect((await api("POST", "/api/a2a/callers", { id: "acme" })).status).toBe(409);

    const enabled = await api("POST", "/api/a2a/enable", {});
    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({
      state: "enabled",
      configPath: await realpath(configFile),
      publicUrl: "https://ws.stage-flow.dev",
      agentCardUrl: "https://ws.stage-flow.dev/.well-known/agent-card.json",
      callers: 0,
      publications: 0,
      lastReload: { ok: true },
    });
    expect(parse(await readFile(configFile, "utf8"))).toEqual({ version: 1, callers: [], publications: [] });

    const created = await api("POST", "/api/a2a/callers", { id: "acme" });
    expect(created.status).toBe(201);
    expect(created.body.id).toBe("acme");
    expect(created.body.token).toMatch(/^[0-9a-f]{48}$/);
    expect(created.body.token_source).toBe("store");
    expect(await agentCardStatus(url, created.body.token)).toBe(200);
    expect(await agentCardStatus(url, "x".repeat(48))).toBe(401);
    expect((await api("GET", "/api/a2a/callers")).body).toEqual({ callers: [{ id: "acme", token_source: "store" }] });
  });

  it("revokes a caller so its token stops working, removes it from allowed callers, and allows revoking the last one", async () => {
    const { api, url, project, secrets, configFile } = await setup();
    await api("POST", "/api/a2a/enable", {});
    const acme = (await api("POST", "/api/a2a/callers", { id: "acme" })).body.token as string;
    const beta = (await api("POST", "/api/a2a/callers", { id: "beta" })).body.token as string;
    expect((await api("POST", "/api/a2a/publications", publicationBody(project, { allowed_callers: ["acme", "beta"] }))).status).toBe(201);

    const revoked = await api("DELETE", "/api/a2a/callers/acme");
    expect(revoked.body).toEqual({ revoked: true, removed_from: ["supplier_assessment"] });
    expect(await agentCardStatus(url, acme)).toBe(401);
    expect(await agentCardStatus(url, beta)).toBe(200);
    expect(secrets.get(A2A_CALLER_STORE_PREFIX + "acme")).toBeUndefined();
    expect((await api("GET", "/api/a2a/publications/supplier_assessment")).body.allowed_callers).toEqual(["beta"]);

    expect((await api("DELETE", "/api/a2a/callers/beta")).status).toBe(200);
    expect(await agentCardStatus(url, beta)).toBe(401);
    expect((await api("GET", "/api/a2a/publications/supplier_assessment")).body.allowed_callers).toEqual([]);
    expect(parse(await readFile(configFile, "utf8")).callers).toEqual([]);
    expect((await api("DELETE", "/api/a2a/callers/beta")).status).toBe(404);
  });

  it("creates, edits, lists and removes a publication with an allowed-callers list", async () => {
    const { api, project, url } = await setup();
    await api("POST", "/api/a2a/enable", {});
    const token = (await api("POST", "/api/a2a/callers", { id: "acme" })).body.token as string;

    const unknown = await api("POST", "/api/a2a/publications", publicationBody(project, { allowed_callers: ["ghost"] }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe("a2a_unknown_caller");
    const outside = await api("POST", "/api/a2a/publications", publicationBody(project, { pipeline: "../escape.pipeline.yaml" }));
    expect(outside.status).toBe(400);
    expect((await api("POST", "/api/a2a/publications", publicationBody("/not/a/catalog/root"))).status).toBe(400);

    const preview = await api("POST", "/api/a2a/publications/preview", publicationBody(project));
    expect(preview.status).toBe(200);
    expect(preview.body.inputSchema.required).toEqual(["supplier"]);
    expect(preview.body.artifacts).toEqual(["assessment.md"]);

    const created = await api("POST", "/api/a2a/publications", publicationBody(project, { allowed_callers: ["acme"] }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: "supplier_assessment", project_root: project, pipeline: "supplier.pipeline.yaml", allowed_callers: ["acme"] });
    expect((await api("POST", "/api/a2a/publications", publicationBody(project))).status).toBe(409);

    const card = (await (await fetch(`${url}/.well-known/agent-card.json`, { headers: { authorization: `Bearer ${token}` } })).json()) as { skills: Array<{ id: string }> };
    expect(card.skills.map((skill) => skill.id)).toEqual(["supplier_assessment"]);

    const listed = await api("GET", "/api/a2a/publications");
    expect(listed.body.publications.map((p: { id: string; revision: string }) => p.id)).toEqual(["supplier_assessment"]);
    const before = created.body.revision ?? listed.body.publications[0].revision;

    const edited = await api("PATCH", "/api/a2a/publications/supplier_assessment", { description: "Changed.", results: { include_payload: false }, allowed_callers: [] });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ description: "Changed.", allowed_callers: [], results: { stage: "final_report", include_payload: false } });
    const fetched = await api("GET", "/api/a2a/publications/supplier_assessment");
    expect(fetched.body.contract.revision).not.toBe(before);
    expect(fetched.body.contract.outputSchema).toBeDefined();
    expect((await api("PATCH", "/api/a2a/publications/supplier_assessment", { results: { stage: "missing" } })).status).toBe(400);
    expect((await api("GET", "/api/a2a/publications/supplier_assessment")).body.description).toBe("Changed.");

    expect((await api("PATCH", "/api/a2a/publications/supplier_assessment", { input_schema: "supplier.schema.json", project_root: project })).status).toBe(200);
    expect((await api("DELETE", "/api/a2a/publications/supplier_assessment")).body).toEqual({ removed: true });
    expect((await api("GET", "/api/a2a/publications/supplier_assessment")).status).toBe(404);
    expect((await api("DELETE", "/api/a2a/publications/supplier_assessment")).status).toBe(404);
  });

  it("never returns a token after creation and never stores one", async () => {
    const { api, project, base, secrets, host, storeRoot, store, configFile } = await setup();
    await api("POST", "/api/a2a/enable", {});
    const token = (await api("POST", "/api/a2a/callers", { id: "acme" })).body.token as string;
    await api("POST", "/api/a2a/publications", publicationBody(project, { allowed_callers: ["acme"] }));
    await api("GET", "/api/a2a/callers");
    await api("GET", "/api/a2a/publications");
    await api("GET", "/api/a2a/status");
    await api("POST", "/api/a2a/reload");
    await api("POST", "/api/a2a/callers", { id: "acme" });
    await api("POST", "/api/a2a/callers", { id: "bad id" });
    await api("DELETE", "/api/a2a/callers/missing");
    expect(bodies.filter((body) => body.includes(token))).toHaveLength(1);
    expect(JSON.stringify(host.status)).not.toContain(token);

    const stored = readFileSync(path.join(base, "creds", "channel-secrets.json"), "utf8");
    expect(stored).not.toContain(token);
    expect(JSON.parse(stored)[A2A_CALLER_STORE_PREFIX + "acme"]).toBe(tokenDigestHex(token));
    expect((await stat(path.join(base, "creds", "channel-secrets.json"))).mode & 0o777).toBe(0o600);
    expect(await readFile(configFile, "utf8")).not.toContain(token);
    expect(secrets.get(A2A_CALLER_STORE_PREFIX + "acme")).not.toBe(token);

    const home = storeRootFor(storeRoot);
    await writeFile(path.join(home, "settings.json"), "{}\n");
    const backup = await createBackup({ store, homeDir: home, outPath: path.join(home, "backups", "full.tar.gz") });
    const archive = gunzipSync(readFileSync(backup.path)).toString("latin1");
    expect(archive).not.toContain(token);
    expect(archive).not.toContain(tokenDigestHex(token));
  });

  it("keeps a task's own settings after the publication is edited or removed, and refuses reusing a revoked id with retained tasks", async () => {
    const { api, url, project } = await setup();
    await api("POST", "/api/a2a/enable", {});
    const token = (await api("POST", "/api/a2a/callers", { id: "acme" })).body.token as string;
    await api("POST", "/api/a2a/publications", publicationBody(project, { allowed_callers: ["acme"] }));
    const client = await clientFor(url, token);
    const sent = await startTask(client);
    const waiting = await waitForState(client, sent.id, [6]);
    const part = waiting.status.message!.parts[0].content as { $case: "data"; value: { questions: Array<{ handle: string }> } };

    await api("PATCH", "/api/a2a/publications/supplier_assessment", { results: { include_payload: false, artifacts: [] }, caller_answerable_stages: [] });
    await api("DELETE", "/api/a2a/publications/supplier_assessment");

    const answered = (await client.sendMessage({
      tenant: "",
      message: dataMessage(sent.id, { contractVersion: 1, operation: "answer", prompt: part.value.questions[0].handle, answer: { kind: "free_text", text: "Yes." } }),
      configuration: undefined,
      metadata: undefined,
    })) as Task;
    const done = answered.status.state === 3 ? answered : await waitForState(client, sent.id, [3, 4]);
    expect(done.status.state).toBe(3);
    expect(done.artifacts.map((artifact) => artifact.name).sort()).toEqual(["assessment.md", "result"]);

    expect((await api("DELETE", "/api/a2a/callers/acme")).status).toBe(200);
    const again = await api("POST", "/api/a2a/callers", { id: "acme" });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("a2a_caller_id_retained");
    expect((await api("POST", "/api/a2a/callers", { id: "acme2" })).status).toBe(201);
  });

  it("restores the file and reports the error when a change does not load", async () => {
    const { api, project, configFile, host } = await setup();
    await api("POST", "/api/a2a/enable", {});
    await api("POST", "/api/a2a/callers", { id: "acme" });
    const before = await readFile(configFile, "utf8");
    const bad = await api("POST", "/api/a2a/publications", publicationBody(project, { results: { stage: "clarify", artifacts: [] } }));
    expect(bad.status).toBe(400);
    expect(await readFile(configFile, "utf8")).toBe(before);
    expect(host.status.state).toBe("enabled");
    expect(host.status.lastReload?.ok).toBe(true);
  });

  it("turns A2A off keeping callers, publications and digests, and back on to restore them", async () => {
    const { api, url, project, secrets, configFile, host } = await setup();
    expect((await api("POST", "/api/a2a/disable")).status).toBe(409);
    await api("POST", "/api/a2a/enable", {});
    const token = (await api("POST", "/api/a2a/callers", { id: "acme" })).body.token as string;
    await api("POST", "/api/a2a/publications", publicationBody(project, { allowed_callers: ["acme"] }));

    const off = await api("POST", "/api/a2a/disable");
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ state: "disabled", configPath: await realpath(configFile) });
    expect(off.body.agentCardUrl).toBeUndefined();
    expect(host.registry()).toBeUndefined();
    expect(await agentCardStatus(url, token)).toBe(404);
    expect(parse(await readFile(configFile, "utf8"))).toMatchObject({ enabled: false, callers: [{ id: "acme" }], publications: [{ id: "supplier_assessment" }] });
    expect(secrets.get(A2A_CALLER_STORE_PREFIX + "acme")).toMatch(/^[0-9a-f]{64}$/);
    expect((await api("POST", "/api/a2a/disable")).status).toBe(200);
    const blocked = await api("POST", "/api/a2a/callers", { id: "beta" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("a2a_not_enabled");

    const on = await api("POST", "/api/a2a/enable", {});
    expect(on.body).toMatchObject({ state: "enabled", callers: 1, publications: 1 });
    expect(parse(await readFile(configFile, "utf8")).enabled).toBeUndefined();
    expect(await agentCardStatus(url, token)).toBe(200);
  });

  it("stays off after a restart", async () => {
    const { api, configFile, secrets, env, base } = await setup();
    await api("POST", "/api/a2a/enable", {});
    await api("POST", "/api/a2a/disable");
    const { store, connection } = createRunStoreWithConnection({ rootDir: path.join(base, "again") });
    const manager = new RunManager({ agent: supplierAgent(), store, cwd: base });
    const restarted = await createA2aHost({ manager, runStore: store, rootDir: path.join(base, "again"), connection }, configFile, env, secrets);
    expect(restarted.status.state).toBe("disabled");
    expect(restarted.status.configPath).toBe(await realpath(configFile));
    restarted.close();
  });

  it("describes a pipeline's terminal stages, declared artifacts and free-text-only stages", async () => {
    const { api, project } = await setup();
    const query = (pipeline: string, root = project) =>
      `/api/a2a/pipeline-stages?project_root=${encodeURIComponent(root)}&pipeline=${encodeURIComponent(pipeline)}`;
    const described = await api("GET", query("supplier.pipeline.yaml"));
    expect(described.status).toBe(200);
    expect(described.body.stages).toEqual([
      { id: "clarify", terminal: false, artifacts: [], freeTextOnly: true },
      { id: "final_report", terminal: true, artifacts: ["assessment.md"], freeTextOnly: false },
    ]);
    expect((await api("GET", "/api/a2a/pipeline-stages")).status).toBe(400);
    expect((await api("GET", query("../escape.pipeline.yaml"))).body.code).toBe("a2a_path_invalid");
    expect((await api("GET", query("missing.pipeline.yaml"))).status).toBe(400);
  });

  it("rejects enabling without a public URL, and takes an explicit one", async () => {
    const { api, host } = await setup({ env: { STAGEFLOW_PUBLIC_URL: "" } });
    const missing = await api("POST", "/api/a2a/enable", {});
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("a2a_public_url_required");
    expect((await api("POST", "/api/a2a/enable", { public_url: "http://public.example" })).status).toBe(400);
    expect(host.status.state).toBe("disabled");
    const ok = await api("POST", "/api/a2a/enable", { public_url: "https://agents.example.com" });
    expect(ok.body.publicUrl).toBe("https://agents.example.com");
  });

  it("serialises overlapping changes", async () => {
    const { api } = await setup();
    await api("POST", "/api/a2a/enable", {});
    const results = await Promise.all(["a", "b", "c", "d"].map((id) => api("POST", "/api/a2a/callers", { id })));
    expect(results.map((result) => result.status)).toEqual([201, 201, 201, 201]);
    expect((await api("GET", "/api/a2a/callers")).body.callers.map((c: { id: string }) => c.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("A2A management of a hand-edited file", () => {
  it("never shows a filesystem path for a project folder that is not a catalog project", async () => {
    const { api, base, configFile } = await setup();
    const outside = path.join(base, "unlisted");
    await cp(fixture, outside, { recursive: true });
    const raw = parse(await readFile(path.join(fixture, "a2a.yaml"), "utf8"));
    raw.callers = [];
    raw.publications[0].allowed_callers = [];
    raw.publications[0].project_root = outside;
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, stringify(raw));
    expect((await api("POST", "/api/a2a/reload")).status).toBe(200);

    const listed = await api("GET", "/api/a2a/publications");
    expect(listed.status).toBe(200);
    expect(listed.body.publications[0]).toMatchObject({
      project_root: "",
      root_unmanaged: true,
      pipeline: "supplier.pipeline.yaml",
      input_schema: "supplier.schema.json",
    });
    expect(JSON.stringify(listed.body)).not.toContain(base);
    expect(JSON.stringify((await api("GET", "/api/a2a/publications/supplier_assessment")).body)).not.toContain(base);
  });
});

describe("A2A live reload", () => {
  async function plainHost(configPath: string | undefined, env: NodeJS.ProcessEnv, secrets?: ChannelSecretStore) {
    const base = await mkdtemp(path.join(tmpdir(), "sf-a2a-reload-"));
    roots.push(base);
    const { store, connection } = createRunStoreWithConnection({ rootDir: base });
    const manager = new RunManager({ agent: supplierAgent(), store, cwd: base });
    const host = await createA2aHost({ manager, runStore: store, rootDir: base, connection }, configPath, env, secrets);
    const server = createServer(async (req, res) => {
      if (!(await host.handle(req, res, new URL(req.url!, "http://localhost").pathname))) { res.writeHead(404); res.end(); }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing address");
    return { host, url: `http://127.0.0.1:${address.port}` };
  }

  async function configCopy(): Promise<string> {
    const base = await mkdtemp(path.join(tmpdir(), "sf-a2a-reload-config-"));
    roots.push(base);
    await cp(fixture, base, { recursive: true });
    return path.join(base, "a2a.yaml");
  }

  const env = { PROCUREMENT_TOKEN: "p".repeat(40), OTHER_TOKEN: "o".repeat(40) };

  it("swaps callers on reload, keeps the old registry when a reload fails, and records the failure", async () => {
    const configPath = await configCopy();
    const { host, url } = await plainHost(configPath, env);
    expect(await agentCardStatus(url, env.OTHER_TOKEN)).toBe(200);

    const config = parse(await readFile(configPath, "utf8"));
    config.callers = config.callers.filter((caller: { id: string }) => caller.id !== "other");
    await writeFile(configPath, stringify(config));
    expect((await host.reload()).ok).toBe(true);
    expect(await agentCardStatus(url, env.OTHER_TOKEN)).toBe(401);
    expect(await agentCardStatus(url, env.PROCUREMENT_TOKEN)).toBe(200);

    await writeFile(configPath, "version: 1\npublic_url: not a url\n");
    const failed = await host.reload();
    expect(failed.ok).toBe(false);
    expect(host.status.state).toBe("enabled");
    expect(host.status.lastReload).toMatchObject({ ok: false, error: { code: "a2a_reload_failed" } });
    expect(await agentCardStatus(url, env.PROCUREMENT_TOKEN)).toBe(200);
  });

  it("starts from the disabled and configuration-error states", async () => {
    const configPath = await configCopy();
    const { host, url } = await plainHost(undefined, env);
    expect(host.status.state).toBe("disabled");
    expect(await agentCardStatus(url, env.PROCUREMENT_TOKEN)).toBe(404);
    expect((await host.reload()).ok).toBe(false);
    expect(host.status.state).toBe("disabled");
    expect((await host.reload(configPath)).ok).toBe(true);
    expect(host.status.state).toBe("enabled");
    expect(await agentCardStatus(url, env.PROCUREMENT_TOKEN)).toBe(200);

    const broken = await configCopy();
    await writeFile(broken, "version: 2\n");
    const second = await plainHost(broken, env);
    expect(second.host.status.state).toBe("configuration_error");
    expect(await agentCardStatus(second.url, env.PROCUREMENT_TOKEN)).toBe(503);
    await cp(configPath, broken);
    expect((await second.host.reload()).ok).toBe(true);
    expect(second.host.status.state).toBe("enabled");
    expect(second.host.status.error).toBeUndefined();
    expect(await agentCardStatus(second.url, env.PROCUREMENT_TOKEN)).toBe(200);
  });

  it("keeps the configuration error in step with the latest failed reload", async () => {
    const broken = await configCopy();
    await writeFile(broken, "version: 2\n");
    const { host } = await plainHost(broken, env);
    expect(host.status.state).toBe("configuration_error");
    const first = host.status.error?.message;
    await writeFile(broken, "version: 1\ncallers: nope\n");
    const result = await host.reload();
    expect(result.ok).toBe(false);
    expect(host.status.state).toBe("configuration_error");
    expect(host.status.error?.code).toBe("a2a_configuration_error");
    expect(host.status.error?.message).toBe(host.status.lastReload?.error?.message);
    expect(host.status.error?.message).not.toBe(first);
  });

  it("runs concurrent reloads one at a time and keeps the rate limiter across a swap", async () => {
    const configPath = await configCopy();
    const { host, url } = await plainHost(configPath, env);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => host.reload().then(() => order.push(n))));
    expect(order).toEqual([1, 2, 3]);

    const client = await clientFor(url, env.PROCUREMENT_TOKEN);
    const probe = () => client.getTask({ tenant: "", id: "missing", historyLength: undefined }).catch((error: Error) => error.message);
    for (let i = 0; i < 20; i += 1) await probe();
    expect(await probe()).toMatch(/Rate limit/);
    await host.reload();
    expect(await probe()).toMatch(/Rate limit/);
  });
});

describe("token_store callers", () => {
  const writeConfig = async (callers: unknown[]) => {
    const base = await mkdtemp(path.join(tmpdir(), "sf-a2a-store-"));
    roots.push(base);
    await cp(fixture, base, { recursive: true });
    const configPath = path.join(base, "a2a.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.callers = callers;
    await writeFile(configPath, stringify(config));
    return { configPath, secrets: new ChannelSecretStore(path.join(base, "secrets.json")) };
  };

  it("authenticates a stored digest and rejects missing, malformed or ambiguous entries without printing values", async () => {
    const { configPath, secrets } = await writeConfig([{ id: "procurement", token_store: "a2a-caller.procurement" }, { id: "other", token_env: "OTHER_TOKEN" }]);
    const token = "t".repeat(48);
    await expect(loadPublicationRegistry(configPath, { OTHER_TOKEN: "o".repeat(40) }, secrets)).rejects.toThrow("a2a-caller.procurement");
    secrets.set("a2a-caller.procurement", token);
    await expect(loadPublicationRegistry(configPath, { OTHER_TOKEN: "o".repeat(40) }, secrets)).rejects.toThrow(/no token digest/);
    secrets.set("a2a-caller.procurement", tokenDigestHex(token));
    const registry = await loadPublicationRegistry(configPath, { OTHER_TOKEN: "o".repeat(40) }, secrets);
    expect(registry.authenticate(`Bearer ${token}`)).toBe("procurement");
    expect(registry.authenticate(`Bearer ${tokenDigestHex(token)}`)).toBeUndefined();
    expect(registry.authenticate(`Bearer ${"o".repeat(40)}`)).toBe("other");

    for (const caller of [{ id: "a", token_env: "OTHER_TOKEN", token_store: "a2a-caller.a" }, { id: "a" }]) {
      const bad = await writeConfig([caller]);
      await expect(loadPublicationRegistry(bad.configPath, {}, bad.secrets)).rejects.toThrow(/Exactly one of token_env or token_store/);
    }
  });

  it("loads a configuration with no callers and no publications, and a publication with no allowed callers", async () => {
    const { configPath, secrets } = await writeConfig([]);
    const config = parse(await readFile(configPath, "utf8"));
    config.publications[0].allowed_callers = [];
    await writeFile(configPath, stringify(config));
    const registry = await loadPublicationRegistry(configPath, {}, secrets);
    expect(registry.callers()).toEqual([]);
    config.publications = [];
    await writeFile(configPath, stringify(config));
    expect((await loadPublicationRegistry(configPath, {}, secrets)).summaries()).toEqual([]);
  });
});

describe("A2A config location", () => {
  it("prefers the explicit setting, then the project file, then the host-level file", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "sf-a2a-location-"));
    roots.push(base);
    const project = path.join(base, "project");
    const home = path.join(base, "home");
    await cp(fixture, project, { recursive: true });
    await cp(fixture, home, { recursive: true });
    await rm(path.join(project, "a2a.yaml"));
    const env = { STAGEFLOW_HOME: home };
    expect(hostA2aConfigFile(env)).toBe(path.join(home, "a2a.yaml"));
    expect(resolveA2aConfigPath(project, env)).toBe(path.join(home, "a2a.yaml"));
    await writeFile(path.join(project, "a2a.yaml"), await readFile(path.join(home, "a2a.yaml")));
    expect(resolveA2aConfigPath(project, env)).toBe(path.join(project, "a2a.yaml"));
    expect(resolveA2aConfigPath(project, { ...env, STAGEFLOW_A2A_CONFIG: "/x/a2a.yaml" })).toBe("/x/a2a.yaml");

    const empty = path.join(base, "empty");
    expect(resolveA2aConfigPath(project, { STAGEFLOW_HOME: empty })).toBe(path.join(project, "a2a.yaml"));
    await rm(path.join(project, "a2a.yaml"));
    expect(resolveA2aConfigPath(project, { STAGEFLOW_HOME: empty })).toBeUndefined();
    expect(a2aWriteTargetPath(project, { STAGEFLOW_HOME: empty })).toBe(path.join(empty, "a2a.yaml"));
    expect(existsSync(path.join(empty, "a2a.yaml"))).toBe(false);
  });
});

describe("A2A task table", () => {
  it("adds the pinned settings column to an older table", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "sf-a2a-migrate-"));
    roots.push(base);
    const { connection } = createRunStoreWithConnection({ rootDir: base });
    new A2aStore(base, connection);
    connection.exec("ALTER TABLE a2a_tasks DROP COLUMN pinned_json");
    new A2aStore(base, connection);
    const columns = connection.prepare("PRAGMA table_info(a2a_tasks)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "pinned_json")).toBe(true);
  });
});

describe("sf a2a management commands", () => {
  it("runs through the Host API: enable, create a caller once, publish from a file, revoke", async () => {
    const { url, project, base, host } = await setup();
    const out: string[] = [];
    const errors: string[] = [];
    const run = (args: string[]) => runA2aCommand(args, {
      cwd: base, log: (line) => out.push(line), error: (line) => errors.push(line), hostBaseUrl: url,
      ensureService: async () => ({ ok: true, alreadyRunning: true }),
    });

    expect(await run(["caller", "create", "acme"])).toBe(1);
    expect(errors.join()).toContain("not turned on");
    expect(await run(["enable"])).toBe(0);
    expect(host.status.state).toBe("enabled");
    out.length = 0;
    expect(await run(["caller", "create", "acme"])).toBe(0);
    const token = out.join("\n").match(/\b[0-9a-f]{48}\b/)![0];
    expect(await agentCardStatus(url, token)).toBe(200);
    out.length = 0;
    expect(await run(["caller", "list"])).toBe(0);
    expect(out.join("\n")).toContain("acme\tstore");
    expect(out.join("\n")).not.toContain(token);

    const file = path.join(base, "publication.yaml");
    await writeFile(file, stringify(publicationBody(project, { allowed_callers: ["acme"] })));
    expect(await run(["publication", "create", file])).toBe(0);
    await writeFile(file, stringify({ description: "Edited from the CLI." }));
    expect(await run(["publication", "edit", "supplier_assessment", file])).toBe(0);
    out.length = 0;
    expect(await run(["publication", "list"])).toBe(0);
    expect(out.join("\n")).toContain("supplier_assessment\tacme");
    expect(await run(["status"])).toBe(0);
    expect(out.join("\n")).toContain("A2A: enabled");
    expect(await run(["reload", "--json"])).toBe(0);
    expect(await run(["publication", "remove", "supplier_assessment"])).toBe(0);
    expect(await run(["caller", "revoke", "acme"])).toBe(0);
    expect(await agentCardStatus(url, token)).toBe(401);
    expect(await run(["caller", "revoke", "acme"])).toBe(1);
    expect(await run(["caller"])).toBe(1);
  });
});

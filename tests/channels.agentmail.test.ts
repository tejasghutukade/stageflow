import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENTMAIL_DEFAULT_SUBJECT, createAgentMailProvider } from "../src/channels/providers/agentmail.js";
import { ChannelRegistry } from "../src/channels/registry.js";
import { ChannelError } from "../src/channels/errors.js";
import { ChannelHost, stageChannels } from "../src/channels/host.js";
import { channelProviders } from "../src/channels/providers.js";
import { checkStageChannels } from "../src/preflight/channelChecks.js";
import { loadPipelineFromObject } from "../src/config/loadPipeline.js";
import type { ResolvedConnection } from "../src/channels/types.js";
import type { StageConfig } from "../src/types/stage.js";
import { httpFixture, type HttpFixture } from "./fixtures/httpFixture.js";

const KEY = "am_super-secret-api-key-value";
const roots: string[] = [];
let server: HttpFixture;
beforeEach(async () => { server = await httpFixture(); process.env.AM_TEST_KEY = KEY; });
afterEach(async () => {
  await server.close();
  delete process.env.AM_TEST_KEY;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const make = (extra: Parameters<typeof createAgentMailProvider>[0] = {}) =>
  createAgentMailProvider({ baseUrls: { us: server.url, eu: `${server.url}/eu` }, ...extra });
const conn = (config: { inbox: string; region?: "us" | "eu" } = { inbox: "support@agentmail.to" }): ResolvedConnection<{ inbox: string; region: "us" | "eu" }> =>
  ({ id: "mail", scope: "s", provider: "agentmail", displayName: "mail", config: { region: "us", ...config }, secrets: { apiKey: KEY } });
const message = { text: "hello there" };
const context = { operationKey: "k" };
async function code(promise: Promise<unknown>): Promise<ChannelError | undefined> {
  try { await promise; } catch (error) { return error as ChannelError; }
  return undefined;
}

describe("agentmail config and targets", () => {
  const p = createAgentMailProvider();
  it("is built in and registered", () => {
    expect(channelProviders().map(provider => provider.id)).toContain("agentmail");
    expect(p.operations).toEqual(["send"]);
    expect(p.secrets).toEqual({ required: ["apiKey"] });
  });

  it("accepts an inbox with a default region and an explicit eu region", () => {
    expect(p.validateConfig({ inbox: "a@agentmail.to" })).toEqual({ ok: true, value: { inbox: "a@agentmail.to", region: "us" } });
    expect(p.validateConfig({ inbox: "a@agentmail.to", region: "eu" })).toMatchObject({ ok: true });
  });

  it.each([
    [{}], [{ inbox: "not-an-address" }], [{ inbox: "a@b.test", region: "asia" }], [{ inbox: "a@b.test", apiKey: "x" }],
    [{ inbox: "a b@c.test" }], [null], ["str"],
  ])("rejects config %j", config => {
    expect(p.validateConfig(config).ok).toBe(false);
  });

  it("normalizes a single recipient to a list and keeps cc", () => {
    expect(p.validateTarget({ to: "x@y.test" })).toEqual({ ok: true, value: { to: ["x@y.test"] } });
    expect(p.validateTarget({ to: ["a@y.test", "b@y.test"], cc: ["c@y.test"] })).toEqual({ ok: true, value: { to: ["a@y.test", "b@y.test"], cc: ["c@y.test"] } });
  });

  it.each([
    [{}], [{ to: "nope" }], [{ to: [] }], [{ to: ["a@b.test"], bcc: ["c@b.test"] }], [{ to: "a@b.test", cc: [] }],
    [{ to: Array.from({ length: 21 }, (_, i) => `u${i}@b.test`) }],
  ])("rejects target %j", target => {
    expect(p.validateTarget(target).ok).toBe(false);
  });

  it("describes the inbox as its identity", () => {
    expect(p.describe?.({ inbox: "a@agentmail.to", region: "us" })).toEqual({ identity: "a@agentmail.to" });
  });
});

describe("agentmail send", () => {
  it("posts to the inbox with the key in the header only", async () => {
    server.queue.push({ status: 200, body: JSON.stringify({ message_id: "msg_1", thread_id: "thr_1" }) });
    const receipt = await make().send(conn(), { to: ["a@x.test"], cc: ["c@x.test"] }, { text: "hello there", subject: "Hi" }, context);
    expect(receipt).toMatchObject({ providerMessageId: "msg_1" });
    expect(receipt.warnings).toBeUndefined();
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/v0/inboxes/support%40agentmail.to/messages/send");
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(req.body)).toEqual({ to: ["a@x.test"], cc: ["c@x.test"], subject: "Hi", text: "hello there" });
    expect(req.url + req.body).not.toContain(KEY);
  });

  it("uses a default subject and omits cc when none is given", async () => {
    await make().send(conn(), { to: ["a@x.test"] }, message, context);
    expect(JSON.parse(server.requests[0]!.body)).toEqual({ to: ["a@x.test"], subject: AGENTMAIL_DEFAULT_SUBJECT, text: "hello there" });
  });

  it("uses the eu base url for the eu region", async () => {
    await make().send(conn({ inbox: "a@agentmail.eu", region: "eu" }), { to: ["a@x.test"] }, message, context);
    expect(server.requests[0]!.url).toBe("/eu/v0/inboxes/a%40agentmail.eu/messages/send");
  });

  it("treats a 200 without a parseable body as accepted with a warning", async () => {
    server.queue.push({ status: 200, body: "<html>" });
    const receipt = await make().send(conn(), { to: ["a@x.test"] }, message, context);
    expect(receipt.providerMessageId).toBeUndefined();
    expect(receipt.warnings).toEqual(["CHANNEL_RESPONSE_UNPARSEABLE"]);
  });

  it.each([
    [400, "CHANNEL_INVALID_INPUT", false], [422, "CHANNEL_INVALID_INPUT", false], [404, "CHANNEL_INVALID_INPUT", false],
    [401, "CHANNEL_AUTH_FAILED", false], [403, "CHANNEL_UNAUTHORIZED", false], [429, "CHANNEL_RATE_LIMIT", true],
    [500, "CHANNEL_SEND_OUTCOME_UNKNOWN", false], [502, "CHANNEL_SEND_OUTCOME_UNKNOWN", false], [503, "CHANNEL_SEND_OUTCOME_UNKNOWN", false],
  ] as const)("maps status %i to %s", async (status, expected, retryable) => {
    server.queue.push({ status, body: JSON.stringify({ message: `bad ${KEY}` }) });
    const error = await code(make().send(conn(), { to: ["a@x.test"] }, message, context));
    expect(error).toMatchObject({ code: expected, retryable });
    expect(JSON.stringify(error) + String(error) + String(error?.stack)).not.toContain(KEY);
  });

  it("treats a connection refused before sending as a definite, retryable failure", async () => {
    const closed = await httpFixture();
    const url = closed.url;
    await closed.close();
    const error = await code(createAgentMailProvider({ baseUrls: { us: url } }).send(conn(), { to: ["a@x.test"] }, message, context));
    expect(error).toMatchObject({ code: "CHANNEL_CONNECTION_FAILED", retryable: true });
  });

  it("treats a connection dropped mid-request as an unknown outcome", async () => {
    server.queue.push({ destroy: true });
    expect(await code(make().send(conn(), { to: ["a@x.test"] }, message, context))).toMatchObject({ code: "CHANNEL_SEND_OUTCOME_UNKNOWN", retryable: false });
  });

  it("treats a timeout as an unknown outcome", async () => {
    server.queue.push({ delayMs: 300 });
    expect(await code(make({ sendTimeoutMs: 50 }).send(conn(), { to: ["a@x.test"] }, message, context))).toMatchObject({ code: "CHANNEL_SEND_OUTCOME_UNKNOWN" });
  });

  it("does not follow redirects, so the key never reaches another host", async () => {
    const other = await httpFixture();
    server.queue.push({ status: 307, headers: { location: `${other.url}/steal` } });
    const error = await code(make().send(conn(), { to: ["a@x.test"] }, message, context));
    expect(error).toBeInstanceOf(ChannelError);
    expect(other.requests).toHaveLength(0);
    await other.close();
  });
});

describe("agentmail check", () => {
  it("reads the configured inbox with the key", async () => {
    server.queue.push({ status: 200, body: JSON.stringify({ inbox_id: "support@agentmail.to" }) });
    expect(await make().check(conn())).toMatchObject({ state: "ok" });
    const req = server.requests[0]!;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/v0/inboxes/support%40agentmail.to");
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it.each([
    [401, "CHANNEL_AUTH_FAILED", false], [403, "CHANNEL_UNAUTHORIZED", false], [404, "CHANNEL_INVALID_INPUT", false],
    [429, "CHANNEL_RATE_LIMIT", true], [500, "CHANNEL_CONNECTION_FAILED", true], [503, "CHANNEL_CONNECTION_FAILED", true],
  ] as const)("maps status %i to %s", async (status, expected, retryable) => {
    server.queue.push({ status });
    expect(await make().check(conn())).toMatchObject({ state: "failed", error: { code: expected, retryable } });
  });

  it("reports an unreachable host and a timeout as transient", async () => {
    const closed = await httpFixture();
    const url = closed.url;
    await closed.close();
    expect(await createAgentMailProvider({ baseUrls: { us: url } }).check(conn())).toMatchObject({ error: { code: "CHANNEL_CONNECTION_FAILED", retryable: true } });
    server.queue.push({ delayMs: 300 });
    expect(await make({ checkTimeoutMs: 50 }).check(conn())).toMatchObject({ error: { code: "CHANNEL_TIMEOUT", retryable: true } });
  });

  it("honors an abort signal", async () => {
    server.queue.push({ delayMs: 300 });
    const controller = new AbortController();
    const pending = make().check(conn(), controller.signal);
    controller.abort();
    expect(await pending).toMatchObject({ state: "failed" });
  });
});

describe("agentmail through the host", () => {
  async function workspace() {
    const root = await mkdtemp(path.join(tmpdir(), "sf-am-"));
    roots.push(root);
    await writeFile(path.join(root, "connections.yaml"), "version: 1\nconnections:\n  - id: mail\n    provider: agentmail\n    config: { inbox: support@agentmail.to }\n    secrets: { apiKey: env:AM_TEST_KEY }\n");
    return root;
  }
  const stage = (to: unknown = ["lead@x.test"]): StageConfig => ({ id: "notify", system_prompt: "x", channels: [{ connection: "mail", to, operations: ["send"] }] }) as never;

  it("sends once for a repeated operation key and never exposes the key", async () => {
    const root = await workspace();
    const host = new ChannelHost(root, { providers: [make()] });
    server.fallback = { status: 200, body: JSON.stringify({ message_id: "msg_9", thread_id: "t" }) };
    const channels = stageChannels(host, stage(), "run-1");
    const first = await channels.send({ text: "deployed", subject: "Deploy", operationKey: "k" });
    const second = await channels.send({ text: "deployed", subject: "Deploy", operationKey: "k" });
    expect(second).toEqual(first);
    expect(first).toMatchObject({ channel: "mail", providerMessageId: "msg_9" });
    expect(server.requests).toHaveLength(1);
    expect(JSON.stringify(first)).not.toContain(KEY);
  });

  it("does not resend after an ambiguous failure", async () => {
    const root = await workspace();
    const host = new ChannelHost(root, { providers: [make()] });
    server.queue.push({ status: 502 });
    const channels = stageChannels(host, stage(), "run-1");
    expect((await code(channels.send({ text: "x", operationKey: "k" })))?.code).toBe("CHANNEL_SEND_OUTCOME_UNKNOWN");
    expect((await code(channels.send({ text: "x", operationKey: "k" })))?.code).toBe("CHANNEL_SEND_OUTCOME_UNKNOWN");
    expect(server.requests).toHaveLength(1);
  });

  it("rejects an invalid recipient at validation time", async () => {
    const root = await workspace();
    const registry = new ChannelRegistry({ cwd: root, providers: [make()] });
    expect(() => registry.validateTarget("mail", { to: "not-an-email" })).toThrowError(expect.objectContaining({ code: "CHANNEL_TARGET_INVALID" }));
  });
});

describe("agentmail run-start check", () => {
  async function loaded(root: string) {
    await writeFile(path.join(root, "connections.yaml"), "version: 1\nconnections:\n  - id: mail\n    provider: agentmail\n    config: { inbox: support@agentmail.to }\n    secrets: { apiKey: env:AM_TEST_KEY }\n");
    return loadPipelineFromObject({ id: "p", stages: [{ id: "a", system_prompt: "x", model: "anthropic/claude-sonnet-4-5",
      io: { input: { schema: { type: "object" } }, output: { schema: { type: "object" } } },
      channels: [{ connection: "mail", to: "a@x.test", operations: ["send"] }] }] } as never);
  }
  const fast = { retryDelaysMs: [1, 1] as const, attemptTimeoutMs: 500 };

  it("passes against a healthy inbox and does not send anything", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-am-")); roots.push(root);
    const items = await checkStageChannels(await loaded(root), { projectRoot: root, providers: [make()], ...fast });
    expect(items).toEqual([{ kind: "channel", status: "ok", connection: "mail" }]);
    expect(server.requests.map(r => `${r.method} ${r.url}`)).toEqual(["GET /v0/inboxes/support%40agentmail.to"]);
  });

  it("blocks on a bad key without retrying", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-am-")); roots.push(root);
    server.fallback = { status: 401 };
    const items = await checkStageChannels(await loaded(root), { projectRoot: root, providers: [make()], ...fast });
    expect(items[0]).toMatchObject({ status: "channel_check_failed", channelCode: "CHANNEL_AUTH_FAILED", retryable: false });
    expect(server.requests).toHaveLength(1);
  });

  it("retries a transient outage and recovers, or gives up after two retries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sf-am-")); roots.push(root);
    const pipeline = await loaded(root);
    server.queue.push({ status: 503 }, { status: 200, body: "{}" });
    expect((await checkStageChannels(pipeline, { projectRoot: root, providers: [make()], ...fast }))[0]?.status).toBe("ok");
    expect(server.requests).toHaveLength(2);
    server.requests.length = 0;
    server.fallback = { status: 503 };
    expect((await checkStageChannels(pipeline, { projectRoot: root, providers: [make()], ...fast }))[0]).toMatchObject({ status: "channel_check_failed", retryable: true });
    expect(server.requests).toHaveLength(3);
  });
});

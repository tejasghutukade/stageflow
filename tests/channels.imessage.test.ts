import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { classifySdkError, createPhotonImessageProvider, spectrumTransport, type PhotonImessageTransport } from "../src/channels/providers/photonImessage.js";
import { ChannelRegistry } from "../src/channels/registry.js";
import { ChannelError } from "../src/channels/errors.js";
import { channelProviders } from "../src/channels/providers.js";
import type { ResolvedConnection } from "../src/channels/types.js";
import { httpFixture, type HttpFixture } from "./fixtures/httpFixture.js";

const PROJECT = "proj_123";
const SECRET = "photon-super-secret-value";
let server: HttpFixture;
beforeEach(async () => { server = await httpFixture(); });
afterEach(async () => { await server.close(); });

const calls: Array<{ to: string; text: string; projectId: string }> = [];
const transport = (behavior: () => Promise<{ messageId?: string }> = async () => ({ messageId: "im_1" })): PhotonImessageTransport => ({
  async sendText(credentials, recipient, text) { calls.push({ recipient, text, projectId: credentials.projectId }); return behavior(); },
});
beforeEach(() => { calls.length = 0; });
const make = (t: PhotonImessageTransport = transport(), extra = {}) => createPhotonImessageProvider({ baseUrl: server.url, transport: t, ...extra });
const conn = (withCredential = true): ResolvedConnection<Record<string, never>> => {
  const out: Record<string, unknown> = { id: "im", scope: "s", provider: "imessage", displayName: "im", config: {}, secrets: {} };
  if (withCredential) out.credential = { id: "photon-main", provider: "photon", secrets: { projectId: PROJECT, projectSecret: SECRET } };
  return out as ResolvedConnection<Record<string, never>>;
};
const context = { operationKey: "k" };
const target = { recipient: "+14155550123" };
const tokens = (type: "shared" | "dedicated") => ({ status: 200, body: JSON.stringify({ type }) });
async function fail(promise: Promise<unknown>): Promise<ChannelError | undefined> {
  try { await promise; } catch (error) { return error as ChannelError; }
  return undefined;
}

describe("imessage config and targets", () => {
  const p = createPhotonImessageProvider();
  it("is built in, needs a photon credential, and has no connection secrets", () => {
    expect(channelProviders().map(provider => provider.id)).toContain("imessage");
    expect(p.credentialProvider).toBe("photon");
    expect(p.secrets).toEqual({ required: [] });
  });
  it("accepts empty config only", () => {
    expect(p.validateConfig({}).ok).toBe(true);
    expect(p.validateConfig({ line: "x" }).ok).toBe(false);
  });
  it.each([[{ to: "+14155550123" }], [{ to: "a@b.test" }]])("accepts %j", t => { expect(p.validateTarget(t).ok).toBe(true); });
  it.each([[{}], [{ to: "4155550123" }], [{ to: "+0123" }], [{ to: "not a thing" }], [{ to: "+14155550123", x: 1 }], [{ to: ["+14155550123"] }]])("rejects %j", t => {
    expect(p.validateTarget(t).ok).toBe(false);
  });
});

describe("imessage send", () => {
  it("sends one DM with the subject on a first line", async () => {
    const receipt = await make().send(conn(), target, { text: "hello", subject: "Hi" }, context);
    expect(receipt).toMatchObject({ providerMessageId: "im_1" });
    expect(calls).toEqual([{ recipient: "+14155550123", text: "Hi\n\nhello", projectId: PROJECT }]);
  });
  it("fails without a credential before calling the transport", async () => {
    expect(await fail(make().send(conn(false), target, { text: "x" }, context))).toMatchObject({ code: "CHANNEL_SECRET_UNAVAILABLE" });
    expect(calls).toHaveLength(0);
  });
  it("warns when the transport returns no id", async () => {
    const receipt = await make(transport(async () => ({}))).send(conn(), target, { text: "x" }, context);
    expect(receipt.warnings).toEqual(["CHANNEL_RESPONSE_UNPARSEABLE"]);
  });
  it.each([
    [new Error("Target not allowed for this project"), "CHANNEL_RECIPIENT_REJECTED", false],
    [Object.assign(new Error("x"), { status: 401 }), "CHANNEL_AUTH_FAILED", false],
    [Object.assign(new Error("x"), { status: 403 }), "CHANNEL_UNAUTHORIZED", false],
    [Object.assign(new Error("x"), { status: 429 }), "CHANNEL_RATE_LIMIT", true],
    [new Error(`boom ${SECRET}`), "CHANNEL_SEND_OUTCOME_UNKNOWN", false],
    [new ChannelError("CHANNEL_PROVIDER_UNSUPPORTED"), "CHANNEL_PROVIDER_UNSUPPORTED", false],
  ] as const)("classifies %s", async (thrown, expected, retryable) => {
    const error = await fail(make(transport(async () => { throw thrown; })).send(conn(), target, { text: "x" }, context));
    expect(error).toMatchObject({ code: expected, retryable });
    expect(JSON.stringify(error) + String(error) + String(error?.stack)).not.toContain(SECRET);
  });
  it("treats a hung transport as an unknown outcome", async () => {
    const hang = transport(() => new Promise(() => undefined));
    expect(await fail(make(hang, { sendTimeoutMs: 30 }).send(conn(), target, { text: "x" }, context))).toMatchObject({ code: "CHANNEL_SEND_OUTCOME_UNKNOWN", retryable: false });
  });
  it("classifies non-error throws as unknown", () => {
    expect(classifySdkError("nope", "c").code).toBe("CHANNEL_SEND_OUTCOME_UNKNOWN");
  });
});

describe("imessage spectrum transport", () => {
  const fakeSdk = (log: string[], sendError?: Error) => async (specifier: string) => {
    if (specifier === "spectrum-ts") {
      return { Spectrum: async (options: { projectId: string }) => { log.push(`app:${options.projectId}`); return { stop: async () => { log.push("stop"); } }; } };
    }
    return {
      imessage: Object.assign(
        () => ({
          user: async (recipient: string) => { log.push(`user:${recipient}`); return { recipient }; },
          space: { create: async () => ({ send: async (text: string) => { log.push(`send:${text}`); if (sendError) throw sendError; return { id: "m9" }; } }) },
        }),
        { config: () => ({}) },
      ),
    };
  };
  it("creates the app for one send and stops it", async () => {
    const log: string[] = [];
    const result = await spectrumTransport(fakeSdk(log)).sendText({ projectId: PROJECT, projectSecret: SECRET }, "+14155550123", "yo");
    expect(result).toEqual({ messageId: "m9" });
    expect(log).toEqual([`app:${PROJECT}`, "user:+14155550123", "send:yo", "stop"]);
  });
  it("stops the app when the send fails", async () => {
    const log: string[] = [];
    await expect(spectrumTransport(fakeSdk(log, new Error("x"))).sendText({ projectId: PROJECT, projectSecret: SECRET }, "+14155550123", "yo")).rejects.toThrow();
    expect(log.at(-1)).toBe("stop");
  });
  it("reports a missing SDK as an unsupported provider", async () => {
    const importer = async () => { throw new Error("Cannot find package"); };
    await expect(spectrumTransport(importer).sendText({ projectId: PROJECT, projectSecret: SECRET }, "+14155550123", "yo")).rejects.toMatchObject({ code: "CHANNEL_PROVIDER_UNSUPPORTED" });
  });
});

describe("imessage checks", () => {
  it("check mints a token with basic auth and is ok on 200", async () => {
    server.queue.push(tokens("shared"));
    expect(await make().check(conn())).toMatchObject({ state: "ok" });
    const req = server.requests[0]!;
    expect(req.url).toBe(`/projects/${PROJECT}/imessage/tokens`);
    expect(req.headers.authorization).toBe(`Basic ${Buffer.from(`${PROJECT}:${SECRET}`).toString("base64")}`);
    expect(req.url + req.body).not.toContain(SECRET);
  });
  it.each([[401, "CHANNEL_AUTH_FAILED", false], [403, "CHANNEL_UNAUTHORIZED", false], [429, "CHANNEL_RATE_LIMIT", true], [503, "CHANNEL_CONNECTION_FAILED", true]] as const)("maps check status %i", async (status, code, retryable) => {
    server.queue.push({ status, body: "{}" });
    expect(await make().check(conn())).toMatchObject({ state: "failed", error: { code, retryable } });
  });
  it("check without a credential fails as secret unavailable", async () => {
    expect(await make().check(conn(false))).toMatchObject({ state: "failed", error: { code: "CHANNEL_SECRET_UNAVAILABLE" } });
  });
  it("targets: passes on a shared project when the user is registered", async () => {
    server.queue.push(tokens("shared"), { status: 200, body: JSON.stringify({ users: [{ phoneNumber: "+14155550123" }] }) });
    expect(await make().checkTargets!(conn(), [target])).toMatchObject({ state: "ok" });
    expect(server.requests[1]!.url).toBe(`/projects/${PROJECT}/users/?search=%2B14155550123`);
  });
  it("targets: blocks on a shared project when the user is not registered", async () => {
    server.queue.push(tokens("shared"), { status: 200, body: JSON.stringify({ users: [] }) });
    expect(await make().checkTargets!(conn(), [target])).toMatchObject({ state: "failed", error: { code: "CHANNEL_RECIPIENT_REJECTED", retryable: false } });
  });
  it("targets: skips the lookup on a dedicated line", async () => {
    server.queue.push(tokens("dedicated"));
    expect(await make().checkTargets!(conn(), [target])).toMatchObject({ state: "ok" });
    expect(server.requests).toHaveLength(1);
  });
  it("targets: surfaces a lookup failure", async () => {
    server.queue.push(tokens("shared"), { status: 500, body: "" });
    expect(await make().checkTargets!(conn(), [target])).toMatchObject({ state: "failed", error: { code: "CHANNEL_CONNECTION_FAILED", retryable: true } });
  });
});

describe("imessage through the registry", () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); delete process.env.PH_ID; delete process.env.PH_SECRET; });
  it("resolves the shared photon credential and rejects a connection without one", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sf-im-"));
    roots.push(dir);
    process.env.PH_ID = PROJECT;
    process.env.PH_SECRET = SECRET;
    await writeFile(path.join(dir, "connections.yaml"), [
      "version: 1", "credentials:", "  - id: photon-main", "    provider: photon", "    secrets:", "      projectId: env:PH_ID", "      projectSecret: env:PH_SECRET",
      "connections:", "  - id: im", "    provider: imessage", "    credential: photon-main",
    ].join("\n"));
    const registry = new ChannelRegistry({ cwd: dir, providers: [createPhotonImessageProvider()] });
    const resolved = registry.resolve("im");
    expect(resolved.credential?.secrets).toEqual({ projectId: PROJECT, projectSecret: SECRET });
    expect(JSON.stringify(resolved)).not.toContain(SECRET);
    await writeFile(path.join(dir, "connections.yaml"), ["version: 1", "connections:", "  - id: im", "    provider: imessage"].join("\n"));
    expect(() => new ChannelRegistry({ cwd: dir, providers: [createPhotonImessageProvider()] })).toThrow("CHANNEL_INVALID_INPUT");
  });
});

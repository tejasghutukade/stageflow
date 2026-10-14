import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSlackProvider } from "../src/channels/providers/slack.js";
import { ChannelError } from "../src/channels/errors.js";
import { channelProviders } from "../src/channels/providers.js";
import type { ResolvedConnection } from "../src/channels/types.js";
import { httpFixture, type HttpFixture } from "./fixtures/httpFixture.js";

const TOKEN = "xoxb-super-secret-token-value";
let server: HttpFixture;
beforeEach(async () => { server = await httpFixture(); });
afterEach(async () => { await server.close(); });
const make = () => createSlackProvider({ baseUrl: server.url });
const conn = (config: { teamId?: string } = {}): ResolvedConnection<{ teamId?: string }> =>
  ({ id: "slk", scope: "s", provider: "slack", displayName: "slk", config, secrets: { botToken: TOKEN } });
const context = { operationKey: "k" };
const target = { channel: "C0123ABCD" };
const ok = (extra: object = {}) => ({ status: 200, body: JSON.stringify({ ok: true, ...extra }) });
const err = (name: string) => ({ status: 200, body: JSON.stringify({ ok: false, error: name }) });
async function fail(promise: Promise<unknown>): Promise<ChannelError | undefined> {
  try { await promise; } catch (error) { return error as ChannelError; }
  return undefined;
}

describe("slack config and targets", () => {
  const p = createSlackProvider();
  it("is built in", () => {
    expect(channelProviders().map(provider => provider.id)).toContain("slack");
    expect(p.secrets).toEqual({ required: ["botToken"] });
  });
  it("accepts empty config and a team id", () => {
    expect(p.validateConfig({})).toEqual({ ok: true, value: {} });
    expect(p.validateConfig({ teamId: "T0123ABCD" })).toMatchObject({ ok: true });
    expect(p.describe?.({ teamId: "T0123ABCD" })).toEqual({ identity: "T0123ABCD" });
    expect(p.describe?.({})).toEqual({});
  });
  it.each([[{ teamId: "acme" }], [{ workspace: "x" }], [{ botToken: "x" }], [null]])("rejects config %j", config => {
    expect(p.validateConfig(config).ok).toBe(false);
  });
  it.each([["C0123ABCD"], ["G0123ABCD"], ["D0123ABCD"], ["U0123ABCD"]])("accepts id %s", channel => {
    expect(p.validateTarget({ to: channel })).toEqual({ ok: true, value: { channel } });
  });
  it.each([[{}], [{ to: "#general" }], [{ to: "general" }], [{ to: "c0123abcd" }], [{ channel: "C0123ABCD", extra: 1 }], [{ channel: ["C0123ABCD"] }]])("rejects target %j", t => {
    expect(p.validateTarget(t).ok).toBe(false);
  });
});

describe("slack send", () => {
  it("posts with the token in the header only", async () => {
    server.queue.push(ok({ ts: "1700000000.000100", channel: "C0123ABCD" }));
    const receipt = await make().send(conn(), target, { text: "hello" }, context);
    expect(receipt).toMatchObject({ providerMessageId: "1700000000.000100" });
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/chat.postMessage");
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(req.body)).toMatchObject({ channel: "C0123ABCD", text: "hello", link_names: false, unfurl_links: false });
    expect(req.url + req.body).not.toContain(TOKEN);
  });

  it("puts a subject on a bold first line", async () => {
    server.queue.push(ok({ ts: "1.1" }));
    await make().send(conn(), target, { text: "body", subject: "Done" }, context);
    expect(JSON.parse(server.requests[0]!.body).text).toBe("*Done*\nbody");
  });

  it("warns when the response has no ts", async () => {
    server.queue.push(ok());
    const receipt = await make().send(conn(), target, { text: "x" }, context);
    expect(receipt.warnings).toEqual(["CHANNEL_RESPONSE_UNPARSEABLE"]);
  });

  it.each([
    ["invalid_auth", "CHANNEL_AUTH_FAILED", false], ["token_revoked", "CHANNEL_AUTH_FAILED", false],
    ["missing_scope", "CHANNEL_UNAUTHORIZED", false], ["not_allowed_token_type", "CHANNEL_UNAUTHORIZED", false],
    ["channel_not_found", "CHANNEL_RECIPIENT_REJECTED", false], ["not_in_channel", "CHANNEL_RECIPIENT_REJECTED", false],
    ["is_archived", "CHANNEL_RECIPIENT_REJECTED", false], ["ratelimited", "CHANNEL_RATE_LIMIT", true],
    ["internal_error", "CHANNEL_SEND_OUTCOME_UNKNOWN", false], ["msg_too_long", "CHANNEL_INVALID_INPUT", false],
    ["something_new", "CHANNEL_INVALID_INPUT", false],
  ] as const)("maps ok:false %s to %s", async (name, expected, retryable) => {
    server.queue.push(err(name));
    const error = await fail(make().send(conn(), target, { text: "x" }, context));
    expect(error).toMatchObject({ code: expected, retryable });
  });

  it.each([
    [401, "CHANNEL_AUTH_FAILED", false], [403, "CHANNEL_UNAUTHORIZED", false], [429, "CHANNEL_RATE_LIMIT", true],
    [500, "CHANNEL_SEND_OUTCOME_UNKNOWN", false], [503, "CHANNEL_SEND_OUTCOME_UNKNOWN", false],
  ] as const)("maps status %i to %s", async (status, expected, retryable) => {
    server.queue.push({ status, body: JSON.stringify({ error: `bad ${TOKEN}` }) });
    const error = await fail(make().send(conn(), target, { text: "x" }, context));
    expect(error).toMatchObject({ code: expected, retryable });
    expect(JSON.stringify(error) + String(error) + String(error?.stack)).not.toContain(TOKEN);
  });

  it("treats a 200 with an unparseable body as an unknown outcome", async () => {
    server.queue.push({ status: 200, body: "<html>" });
    expect(await fail(make().send(conn(), target, { text: "x" }, context))).toMatchObject({ code: "CHANNEL_SEND_OUTCOME_UNKNOWN", retryable: false });
  });

  it("treats a dropped connection as an unknown outcome", async () => {
    server.queue.push({ destroy: true });
    expect(await fail(make().send(conn(), target, { text: "x" }, context))).toMatchObject({ code: "CHANNEL_SEND_OUTCOME_UNKNOWN", retryable: false });
  });

  it("refuses redirects", async () => {
    server.queue.push({ status: 302, headers: { location: "http://127.0.0.1:1/" } });
    expect(await fail(make().send(conn(), target, { text: "x" }, context))).toBeInstanceOf(ChannelError);
  });
});

describe("slack check", () => {
  it("is ok when auth.test succeeds", async () => {
    server.queue.push(ok({ team_id: "T0123ABCD" }));
    expect(await make().check(conn())).toMatchObject({ state: "ok" });
    expect(server.requests[0]!.url).toBe("/auth.test");
    expect(server.requests[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });
  it("passes when the pinned team matches and fails when it does not", async () => {
    server.queue.push(ok({ team_id: "T0123ABCD" }), ok({ team_id: "TOTHER99" }));
    expect(await make().check(conn({ teamId: "T0123ABCD" }))).toMatchObject({ state: "ok" });
    expect(await make().check(conn({ teamId: "T0123ABCD" }))).toMatchObject({ state: "failed", error: { code: "CHANNEL_INVALID_INPUT", retryable: false } });
  });
  it.each([
    [err("invalid_auth"), "CHANNEL_AUTH_FAILED", false], [err("account_inactive"), "CHANNEL_AUTH_FAILED", false],
    [err("ratelimited"), "CHANNEL_RATE_LIMIT", true], [err("service_unavailable"), "CHANNEL_CONNECTION_FAILED", true],
    [{ status: 429 }, "CHANNEL_RATE_LIMIT", true], [{ status: 502, body: "" }, "CHANNEL_CONNECTION_FAILED", true],
  ] as const)("maps %j", async (scripted, code, retryable) => {
    server.queue.push(scripted);
    expect(await make().check(conn())).toMatchObject({ state: "failed", error: { code, retryable } });
  });
  it("reports a refused connection as retryable", async () => {
    const closed = await httpFixture();
    const url = closed.url;
    await closed.close();
    expect(await createSlackProvider({ baseUrl: url }).check(conn())).toMatchObject({ state: "failed", error: { code: "CHANNEL_CONNECTION_FAILED", retryable: true } });
  });
});

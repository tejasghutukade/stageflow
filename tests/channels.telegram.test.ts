import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTelegramProvider, TELEGRAM_MAX_TEXT } from "../src/channels/providers/telegram.js";
import { ChannelError } from "../src/channels/errors.js";
import { channelProviders } from "../src/channels/providers.js";
import type { ResolvedConnection } from "../src/channels/types.js";
import { httpFixture, type HttpFixture } from "./fixtures/httpFixture.js";

const TOKEN = "123456:SECRET-bot-token-value";
let server: HttpFixture;
beforeEach(async () => { server = await httpFixture(); });
afterEach(async () => { await server.close(); });
const make = () => createTelegramProvider({ baseUrl: server.url });
const conn = (config: { botUsername?: string } = {}): ResolvedConnection<{ botUsername?: string }> =>
  ({ id: "tg", scope: "s", provider: "telegram", displayName: "tg", config, secrets: { botToken: TOKEN } });
const context = { operationKey: "k" };
const target = { chatId: 42 };
const sent = { status: 200, body: JSON.stringify({ ok: true, result: { message_id: 7 } }) };
const tgErr = (status: number, description: string) => ({ status, body: JSON.stringify({ ok: false, error_code: status, description }) });
async function fail(promise: Promise<unknown>): Promise<ChannelError | undefined> {
  try { await promise; } catch (error) { return error as ChannelError; }
  return undefined;
}

describe("telegram config and targets", () => {
  const p = createTelegramProvider();
  it("is built in", () => {
    expect(channelProviders().map(provider => provider.id)).toContain("telegram");
    expect(p.secrets).toEqual({ required: ["botToken"] });
    expect(p.describe?.({ botUsername: "acme_bot" })).toEqual({ identity: "@acme_bot" });
  });
  it.each([[{}], [{ botUsername: "acme_bot" }]])("accepts config %j", config => { expect(p.validateConfig(config).ok).toBe(true); });
  it.each([[{ botUsername: "x" }], [{ token: "t" }], [null]])("rejects config %j", config => { expect(p.validateConfig(config).ok).toBe(false); });
  it.each([[{ to: 42 }], [{ to: -1001234567890 }], [{ to: "-1001234567890" }], [{ to: "@acme_channel" }]])("accepts target %j", t => {
    expect(p.validateTarget(t).ok).toBe(true);
  });
  it.each([[{}], [{ to: "acme" }], [{ to: "@a" }], [{ to: 1.5 }], [{ to: 42, x: 1 }], [{ to: "" }]])("rejects target %j", t => {
    expect(p.validateTarget(t).ok).toBe(false);
  });
});

describe("telegram send", () => {
  it("posts to sendMessage with the token only in the path", async () => {
    server.queue.push(sent);
    const receipt = await make().send(conn(), target, { text: "hello", subject: "Hi" }, context);
    expect(receipt).toMatchObject({ providerMessageId: "7" });
    const req = server.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`/bot${TOKEN}/sendMessage`);
    expect(JSON.parse(req.body)).toMatchObject({ chat_id: 42, text: "Hi\n\nhello" });
    expect(req.body).not.toContain(TOKEN);
    expect(JSON.stringify(req.headers)).not.toContain(TOKEN);
  });

  it("rejects over-long text before calling", async () => {
    const error = await fail(make().send(conn(), target, { text: "x".repeat(TELEGRAM_MAX_TEXT + 1) }, context));
    expect(error).toMatchObject({ code: "CHANNEL_INVALID_INPUT", retryable: false });
    expect(server.requests).toHaveLength(0);
  });

  it.each([
    [tgErr(403, "Forbidden: bot was blocked by the user"), "CHANNEL_RECIPIENT_REJECTED", false],
    [tgErr(400, "Bad Request: chat not found"), "CHANNEL_RECIPIENT_REJECTED", false],
    [tgErr(400, "Bad Request: can't parse entities"), "CHANNEL_INVALID_INPUT", false],
    [tgErr(401, "Unauthorized"), "CHANNEL_AUTH_FAILED", false],
    [tgErr(404, "Not Found"), "CHANNEL_AUTH_FAILED", false],
    [tgErr(429, "Too Many Requests: retry after 5"), "CHANNEL_RATE_LIMIT", true],
    [tgErr(500, "Internal"), "CHANNEL_SEND_OUTCOME_UNKNOWN", false],
    [{ status: 502, body: "<html>" }, "CHANNEL_SEND_OUTCOME_UNKNOWN", false],
  ] as const)("maps %j", async (scripted, expected, retryable) => {
    server.queue.push(scripted);
    const error = await fail(make().send(conn(), target, { text: "x" }, context));
    expect(error).toMatchObject({ code: expected, retryable });
    expect(JSON.stringify(error) + String(error) + String(error?.stack)).not.toContain(TOKEN);
  });

  it("treats 200 without ok as unknown and without message_id as a warning", async () => {
    server.queue.push({ status: 200, body: "<html>" }, { status: 200, body: JSON.stringify({ ok: true, result: {} }) });
    expect(await fail(make().send(conn(), target, { text: "x" }, context))).toMatchObject({ code: "CHANNEL_SEND_OUTCOME_UNKNOWN" });
    expect((await make().send(conn(), target, { text: "x" }, context)).warnings).toEqual(["CHANNEL_RESPONSE_UNPARSEABLE"]);
  });

  it("treats a dropped connection as unknown and never leaks the token from network errors", async () => {
    server.queue.push({ destroy: true });
    const error = await fail(make().send(conn(), target, { text: "x" }, context));
    expect(error).toMatchObject({ code: "CHANNEL_SEND_OUTCOME_UNKNOWN", retryable: false });
    expect(JSON.stringify(error) + String(error) + String(error?.stack)).not.toContain(TOKEN);
  });

  it("refuses redirects", async () => {
    server.queue.push({ status: 302, headers: { location: "http://127.0.0.1:1/" } });
    expect(await fail(make().send(conn(), target, { text: "x" }, context))).toBeInstanceOf(ChannelError);
  });
});

describe("telegram check", () => {
  const me = (username: string) => ({ status: 200, body: JSON.stringify({ ok: true, result: { username } }) });
  it("is ok when getMe succeeds", async () => {
    server.queue.push(me("acme_bot"));
    expect(await make().check(conn())).toMatchObject({ state: "ok" });
    expect(server.requests[0]!.url).toBe(`/bot${TOKEN}/getMe`);
  });
  it("enforces a pinned bot username case-insensitively", async () => {
    server.queue.push(me("Acme_Bot"), me("other_bot"));
    expect(await make().check(conn({ botUsername: "acme_bot" }))).toMatchObject({ state: "ok" });
    expect(await make().check(conn({ botUsername: "acme_bot" }))).toMatchObject({ state: "failed", error: { code: "CHANNEL_INVALID_INPUT" } });
  });
  it.each([
    [tgErr(401, "Unauthorized"), "CHANNEL_AUTH_FAILED", false], [tgErr(404, "Not Found"), "CHANNEL_AUTH_FAILED", false],
    [tgErr(429, "slow"), "CHANNEL_RATE_LIMIT", true], [tgErr(502, "bad"), "CHANNEL_CONNECTION_FAILED", true],
  ] as const)("maps %j", async (scripted, code, retryable) => {
    server.queue.push(scripted);
    expect(await make().check(conn())).toMatchObject({ state: "failed", error: { code, retryable } });
  });
  it("reports a refused connection as retryable", async () => {
    const closed = await httpFixture();
    const url = closed.url;
    await closed.close();
    expect(await createTelegramProvider({ baseUrl: url }).check(conn())).toMatchObject({ state: "failed", error: { code: "CHANNEL_CONNECTION_FAILED", retryable: true } });
  });
});

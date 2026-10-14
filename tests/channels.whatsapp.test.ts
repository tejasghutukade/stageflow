import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyWhatsappError, createPhotonWhatsappProvider, fillTemplate, spectrumWhatsappTransport, templateParam,
  type PhotonWhatsappTransport, type WhatsappOutbound,
} from "../src/channels/providers/photonWhatsapp.js";
import { createPhotonImessageProvider } from "../src/channels/providers/photonImessage.js";
import { createSlackProvider } from "../src/channels/providers/slack.js";
import { createTelegramProvider } from "../src/channels/providers/telegram.js";
import { parseChannels, channelTarget } from "../src/channels/stageChannels.js";
import { ChannelError } from "../src/channels/errors.js";
import { channelProviders } from "../src/channels/providers.js";
import type { ResolvedConnection } from "../src/channels/types.js";
import { httpFixture, type HttpFixture } from "./fixtures/httpFixture.js";

const PROJECT = "proj_123";
const SECRET = "photon-super-secret-value";
let server: HttpFixture;
const calls: Array<{ recipient: string; outbound: WhatsappOutbound }> = [];
beforeEach(async () => { server = await httpFixture(); calls.length = 0; });
afterEach(async () => { await server.close(); });

const transport = (behavior: () => Promise<{ messageId?: string }> = async () => ({ messageId: "wa_1" })): PhotonWhatsappTransport => ({
  async send(_credentials, recipient, outbound) { calls.push({ recipient, outbound }); return behavior(); },
});
const make = (t = transport(), extra = {}) => createPhotonWhatsappProvider({ baseUrl: server.url, transport: t, ...extra });
const conn = (withCredential = true): ResolvedConnection<Record<string, never>> => {
  const out: Record<string, unknown> = { id: "wa", scope: "s", provider: "whatsapp", displayName: "wa", config: {}, secrets: {} };
  if (withCredential) out.credential = { id: "photon-main", provider: "photon", secrets: { projectId: PROJECT, projectSecret: SECRET } };
  return out as ResolvedConnection<Record<string, never>>;
};
const context = { operationKey: "k" };
const template = { name: "order_update", languageCode: "en_US", bodyParams: ["Hello", "{{message}}"] };
async function fail(promise: Promise<unknown>): Promise<ChannelError | undefined> {
  try { await promise; } catch (error) { return error as ChannelError; }
  return undefined;
}

describe("whatsapp config and targets", () => {
  const p = createPhotonWhatsappProvider();
  it("is built in and needs a photon credential", () => {
    expect(channelProviders().map(provider => provider.id)).toContain("whatsapp");
    expect(p.credentialProvider).toBe("photon");
  });
  it("normalizes a plain target and a template target", () => {
    expect(p.validateTarget({ to: "+14155550123" })).toEqual({ ok: true, value: { recipient: "+14155550123" } });
    expect(p.validateTarget({ to: "+14155550123", template })).toEqual({ ok: true, value: { recipient: "+14155550123", template } });
  });
  it.each([
    [{}], [{ to: "a@b.test" }], [{ to: ["+14155550123"] }], [{ to: "+14155550123", cc: ["+14155550124"] }],
    [{ to: "+14155550123", template: { name: "Bad Name", languageCode: "en_US" } }],
    [{ to: "+14155550123", template: { name: "ok", languageCode: "english" } }],
    [{ to: "+14155550123", template: { name: "ok", languageCode: "en", bodyParams: [""] } }],
    [{ to: "+14155550123", template: { name: "ok", languageCode: "en", extra: 1 } }],
  ])("rejects %j", t => { expect(p.validateTarget(t).ok).toBe(false); });
});

describe("whatsapp templates", () => {
  it("flattens whitespace in parameters", () => {
    expect(templateParam("a\nb\t\tc   d \r\n")).toBe("a b c d");
  });
  it("fills the message placeholder and keeps other parameters", () => {
    expect(fillTemplate(template, { text: "line1\nline2", subject: "Done" }, "wa").bodyParams).toEqual(["Hello", "Done: line1 line2"]);
  });
  it("rejects a message that makes a parameter too long or empty", () => {
    expect(() => fillTemplate(template, { text: "x".repeat(1100) }, "wa")).toThrow("CHANNEL_INVALID_INPUT");
    expect(() => fillTemplate({ name: "n", languageCode: "en", bodyParams: ["{{message}}"] }, { text: "\n" }, "wa")).toThrow("CHANNEL_INVALID_INPUT");
  });
  it("passes a template without parameters through", () => {
    expect(fillTemplate({ name: "n", languageCode: "en" }, { text: "x" }, "wa")).toEqual({ name: "n", languageCode: "en" });
  });
});

describe("whatsapp send", () => {
  it("sends free-form text when no template is pinned", async () => {
    const receipt = await make().send(conn(), { recipient: "+14155550123" }, { text: "hi", subject: "S" }, context);
    expect(receipt).toMatchObject({ providerMessageId: "wa_1" });
    expect(calls).toEqual([{ recipient: "+14155550123", outbound: { text: "S\n\nhi" } }]);
  });
  it("sends the pinned template with the filled message", async () => {
    await make().send(conn(), { recipient: "+14155550123", template }, { text: "shipped" }, context);
    expect(calls[0]!.outbound).toEqual({ template: { ...template, bodyParams: ["Hello", "shipped"] } });
  });
  it("does not call the transport when the template cannot be filled", async () => {
    expect(await fail(make().send(conn(), { recipient: "+14155550123", template }, { text: "x".repeat(2000) }, context))).toMatchObject({ code: "CHANNEL_INVALID_INPUT" });
    expect(calls).toHaveLength(0);
  });
  it("fails without a credential before calling the transport", async () => {
    expect(await fail(make().send(conn(false), { recipient: "+14155550123" }, { text: "x" }, context))).toMatchObject({ code: "CHANNEL_SECRET_UNAVAILABLE" });
    expect(calls).toHaveLength(0);
  });
  it.each([
    [Object.assign(new Error("x"), { code: 131047 }), "CHANNEL_WINDOW_CLOSED", false],
    [new Error("(#131047) Re-engagement message"), "CHANNEL_WINDOW_CLOSED", false],
    [{ error: { code: 131026 } }, "CHANNEL_RECIPIENT_REJECTED", false],
    [Object.assign(new Error("x"), { code: 132001 }), "CHANNEL_INVALID_INPUT", false],
    [Object.assign(new Error("x"), { code: 131056 }), "CHANNEL_RATE_LIMIT", true],
    [Object.assign(new Error("x"), { code: 190 }), "CHANNEL_AUTH_FAILED", false],
    [Object.assign(new Error("x"), { status: 401 }), "CHANNEL_AUTH_FAILED", false],
    [Object.assign(new Error("x"), { status: 429 }), "CHANNEL_RATE_LIMIT", true],
    [new Error(`boom ${SECRET}`), "CHANNEL_SEND_OUTCOME_UNKNOWN", false],
  ] as const)("classifies %j", async (thrown, expected, retryable) => {
    const error = await fail(make(transport(async () => { throw thrown; })).send(conn(), { recipient: "+14155550123" }, { text: "x" }, context));
    expect(error).toMatchObject({ code: expected, retryable });
    expect(JSON.stringify(error) + String(error) + String(error?.stack)).not.toContain(SECRET);
  });
  it("passes through ChannelErrors and treats a hung transport as unknown", async () => {
    expect(classifyWhatsappError(new ChannelError("CHANNEL_PROVIDER_UNSUPPORTED"), "c").code).toBe("CHANNEL_PROVIDER_UNSUPPORTED");
    const hang = transport(() => new Promise(() => undefined));
    expect(await fail(make(hang, { sendTimeoutMs: 30 }).send(conn(), { recipient: "+14155550123" }, { text: "x" }, context))).toMatchObject({ code: "CHANNEL_SEND_OUTCOME_UNKNOWN" });
  });
});

describe("whatsapp spectrum transport", () => {
  const fakeSdk = (log: string[]) => async (specifier: string) => {
    if (specifier === "@spectrum-ts/core") {
      return { Spectrum: async (options: { projectId: string }) => { log.push(`app:${options.projectId}`); return { stop: async () => { log.push("stop"); } }; } };
    }
    return {
      whatsappTemplate: (input: { name: string }) => ({ tpl: input.name }),
      whatsappBusiness: Object.assign(
        () => ({
          user: async (recipient: string) => ({ recipient }),
          space: { create: async () => ({ send: async (content: unknown) => { log.push(`send:${JSON.stringify(content)}`); return { id: "w9" }; } }) },
        }),
        { config: () => ({}) },
      ),
    };
  };
  it("sends text and templates and always stops the app", async () => {
    const log: string[] = [];
    const t = spectrumWhatsappTransport(fakeSdk(log));
    const creds = { projectId: PROJECT, projectSecret: SECRET };
    expect(await t.send(creds, "+14155550123", { text: "yo" })).toEqual({ messageId: "w9" });
    await t.send(creds, "+14155550123", { template: { name: "order_update", languageCode: "en" } });
    expect(log).toEqual([`app:${PROJECT}`, 'send:"yo"', "stop", `app:${PROJECT}`, 'send:{"tpl":"order_update"}', "stop"]);
  });
  it("reports a missing SDK as unsupported", async () => {
    await expect(spectrumWhatsappTransport(async () => { throw new Error("nope"); }).send({ projectId: "p", projectSecret: "s" }, "+14155550123", { text: "x" }))
      .rejects.toMatchObject({ code: "CHANNEL_PROVIDER_UNSUPPORTED" });
  });
});

describe("whatsapp check", () => {
  it("needs at least one line on the project", async () => {
    server.queue.push({ status: 200, body: JSON.stringify({ succeed: true, data: { auth: { "123": "tok" }, numbers: {} } }) }, { status: 200, body: JSON.stringify({ succeed: true, data: { auth: {} } }) }, { status: 200, body: JSON.stringify({ auth: { "123": "tok" } }) });
    expect(await make().check(conn())).toMatchObject({ state: "ok" });
    expect(server.requests[0]!.url).toBe(`/projects/${PROJECT}/whatsapp-business/tokens`);
    expect(server.requests[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`${PROJECT}:${SECRET}`).toString("base64")}`);
    expect(await make().check(conn())).toMatchObject({ state: "failed", error: { code: "CHANNEL_INVALID_INPUT", retryable: false } });
    expect(await make().check(conn())).toMatchObject({ state: "ok" });
  });
  it.each([[401, "CHANNEL_AUTH_FAILED", false], [429, "CHANNEL_RATE_LIMIT", true], [503, "CHANNEL_CONNECTION_FAILED", true]] as const)("maps status %i", async (status, code, retryable) => {
    server.queue.push({ status, body: "{}" });
    expect(await make().check(conn())).toMatchObject({ state: "failed", error: { code, retryable } });
  });
});

describe("stage yaml targets reach every provider", () => {
  const entry = (connection: string, to: unknown, extra: object = {}) => {
    const parsed = parseChannels([{ connection, operations: ["send"], to, ...extra }]);
    if (!parsed.ok) throw new Error(parsed.message);
    return channelTarget(parsed.value[0]!);
  };
  it("validates the `to` shape each provider expects", () => {
    expect(createSlackProvider().validateTarget(entry("s", "C0123ABCD"))).toMatchObject({ ok: true, value: { channel: "C0123ABCD" } });
    expect(createTelegramProvider().validateTarget(entry("t", -1001234567890))).toMatchObject({ ok: true, value: { chatId: "-1001234567890" } });
    expect(createTelegramProvider().validateTarget(entry("t", "@acme_news"))).toMatchObject({ ok: true });
    expect(createPhotonImessageProvider().validateTarget(entry("i", "+14155550123"))).toMatchObject({ ok: true, value: { recipient: "+14155550123" } });
    expect(createPhotonWhatsappProvider().validateTarget(entry("w", "+14155550123", { template }))).toMatchObject({ ok: true, value: { template } });
  });
  it("rejects a list or cc for single-target providers", () => {
    expect(createSlackProvider().validateTarget(entry("s", ["C0123ABCD", "C0123ABCE"])).ok).toBe(false);
    expect(createPhotonImessageProvider().validateTarget(entry("i", "+14155550123", { cc: ["+14155550124"] })).ok).toBe(false);
  });
});

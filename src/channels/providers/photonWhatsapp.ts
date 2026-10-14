import { z } from "zod";
import { ChannelError } from "../errors.js";
import { httpCall, parseJson, statusFailure } from "../http.js";
import type { ChannelProvider, ConnectionHealth, OutboundMessage, SendContext, SendReceipt } from "../types.js";
import { PHOTON_BASE_URL, credentialsOf, photonHeaders, type PhotonCredentials } from "./photonImessage.js";

export type WhatsappTemplate = { name: string; languageCode: string; bodyParams?: string[] };
export type WhatsappTarget = { recipient: string; template?: WhatsappTemplate };
export type WhatsappConfig = Record<string, never>;

export const MESSAGE_PLACEHOLDER = "{{message}}";
export const MAX_TEMPLATE_PARAM = 1024;

/** One outbound message. `template` is sent as an approved template, otherwise `text` is free-form. */
export type WhatsappOutbound = { text: string } | { template: WhatsappTemplate };

export interface PhotonWhatsappTransport {
  send(credentials: PhotonCredentials, recipient: string, outbound: WhatsappOutbound): Promise<{ messageId?: string }>;
}

const templateSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]{1,512}$/),
  languageCode: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
  bodyParams: z.array(z.string().min(1).max(MAX_TEMPLATE_PARAM)).max(10).optional(),
}).strict();
const targetSchema = z.object({
  to: z.string().regex(/^\+[1-9]\d{6,14}$/),
  template: templateSchema.optional(),
}).strict();

export type PhotonWhatsappOptions = {
  fetch?: typeof fetch;
  baseUrl?: string;
  transport?: PhotonWhatsappTransport;
  sendTimeoutMs?: number;
  checkTimeoutMs?: number;
};

/** Template parameters cannot hold newlines, tabs or long runs of spaces. */
export function templateParam(text: string): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
}

/** Fills `{{message}}` in the pinned parameters. Fails before sending if a result is empty or too long. */
export function fillTemplate(template: WhatsappTemplate, message: OutboundMessage, connectionId: string): WhatsappTemplate {
  const text = templateParam(message.subject ? `${message.subject}: ${message.text}` : message.text);
  const bodyParams = template.bodyParams?.map(param => (param.includes(MESSAGE_PLACEHOLDER) ? param.split(MESSAGE_PLACEHOLDER).join(text) : param));
  if (bodyParams?.some(param => param.length === 0 || param.length > MAX_TEMPLATE_PARAM)) {
    throw new ChannelError("CHANNEL_INVALID_INPUT", false, { connectionId, field: "text" });
  }
  return { ...template, ...(bodyParams ? { bodyParams } : {}) };
}

function metaCode(error: unknown): number | undefined {
  const candidates = [(error as { code?: unknown })?.code, (error as { error?: { code?: unknown } })?.error?.code];
  for (const value of candidates) if (typeof value === "number") return value;
  const match = /\b(13\d{4}|190)\b/.exec(error instanceof Error ? error.message : "");
  return match ? Number(match[1]) : undefined;
}

const RECIPIENT_CODES = new Set([131026, 131030, 131021]);
const INVALID_CODES = new Set([132000, 132001, 132005, 132012, 132015, 132016]);
const RATE_CODES = new Set([131056, 130429, 131048]);

/** Maps SDK and Meta errors. Unclassified errors may have happened after the send, so they are unknown. */
export function classifyWhatsappError(error: unknown, connectionId: string): ChannelError {
  if (error instanceof ChannelError) return error;
  const detail = { connectionId };
  const code = metaCode(error);
  if (code === 131047 || code === 131051) return new ChannelError("CHANNEL_WINDOW_CLOSED", false, detail);
  if (code !== undefined && RECIPIENT_CODES.has(code)) return new ChannelError("CHANNEL_RECIPIENT_REJECTED", false, detail);
  if (code !== undefined && INVALID_CODES.has(code)) return new ChannelError("CHANNEL_INVALID_INPUT", false, detail);
  if (code !== undefined && RATE_CODES.has(code)) return new ChannelError("CHANNEL_RATE_LIMIT", true, detail);
  if (code === 190) return new ChannelError("CHANNEL_AUTH_FAILED", false, detail);
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 401) return new ChannelError("CHANNEL_AUTH_FAILED", false, detail);
  if (status === 403) return new ChannelError("CHANNEL_UNAUTHORIZED", false, detail);
  if (status === 429) return new ChannelError("CHANNEL_RATE_LIMIT", true, detail);
  return new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN", false, detail);
}

/** Same lifecycle as the iMessage transport: lazy import, one app per send, stopped in `finally`. */
export function spectrumWhatsappTransport(importer: (specifier: string) => Promise<any> = specifier => import(specifier)): PhotonWhatsappTransport {
  return {
    async send({ projectId, projectSecret }, recipient, outbound) {
      let core: any;
      let provider: any;
      try {
        core = await importer("spectrum-ts");
        provider = await importer("@spectrum-ts/whatsapp-business");
      } catch {
        throw new ChannelError("CHANNEL_PROVIDER_UNSUPPORTED");
      }
      const app = await core.Spectrum({ projectId, projectSecret, providers: [provider.whatsappBusiness.config()] });
      try {
        const wa = provider.whatsappBusiness(app);
        const user = await wa.user(recipient);
        const space = await wa.space.create(user);
        const content = "template" in outbound ? provider.whatsappTemplate(outbound.template) : outbound.text;
        const sent = await space.send(content);
        const id = sent?.id;
        return typeof id === "string" ? { messageId: id } : {};
      } finally {
        await app.stop().catch(() => undefined);
      }
    },
  };
}

/**
 * WhatsApp Business through a Photon project (cloud mode), 1:1 only. Free-form text works only
 * inside the 24-hour window after the recipient last wrote to the business, so a stage that
 * writes first must pin an approved `template`. Receiving is not part of this phase.
 */
export function createPhotonWhatsappProvider(options: PhotonWhatsappOptions = {}): ChannelProvider<WhatsappConfig, WhatsappTarget> {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl ?? PHOTON_BASE_URL;
  const transport = options.transport ?? spectrumWhatsappTransport();
  const failed = (failure: ChannelError, checkedAt: string): ConnectionHealth =>
    ({ state: "failed", checkedAt, error: { code: failure.code, retryable: failure.retryable } });

  return {
    id: "whatsapp",
    operations: ["send"],
    secrets: { required: [] },
    credentialProvider: "photon",
    validateConfig(config) {
      return z.object({}).strict().safeParse(config).success ? { ok: true, value: {} } : { ok: false, issues: ["config"] };
    },
    validateTarget(target) {
      const parsed = targetSchema.safeParse(target);
      return parsed.success ? { ok: true, value: { recipient: parsed.data.to, ...(parsed.data.template ? { template: parsed.data.template } : {}) } } : { ok: false, issues: parsed.error.issues.map(issue => issue.path.join(".") || "target") };
    },
    async check(connection, signal): Promise<ConnectionHealth> {
      const checkedAt = new Date().toISOString();
      try {
        const credentials = credentialsOf(connection);
        const result = await httpCall({
          fetch: doFetch, url: `${base}/projects/${encodeURIComponent(credentials.projectId)}/whatsapp-business/tokens`, method: "POST",
          headers: photonHeaders(credentials), body: {}, timeoutMs: options.checkTimeoutMs ?? 10000, signal, mode: "check", connectionId: connection.id,
        });
        if (result.status < 200 || result.status >= 300) return failed(statusFailure(result.status, "check", connection.id), checkedAt);
        const auth = (parseJson(result.text) as { auth?: unknown } | undefined)?.auth;
        const lines = auth && typeof auth === "object" ? Object.keys(auth).length : 0;
        return lines > 0 ? { state: "ok", checkedAt } : failed(new ChannelError("CHANNEL_INVALID_INPUT", false, { connectionId: connection.id, field: "whatsapp" }), checkedAt);
      } catch (error) {
        return failed(error instanceof ChannelError ? error : new ChannelError("CHANNEL_CONNECTION_FAILED", true), checkedAt);
      }
    },
    async send(connection, target, message: OutboundMessage, _context: SendContext): Promise<SendReceipt> {
      const credentials = credentialsOf(connection);
      const outbound: WhatsappOutbound = target.template
        ? { template: fillTemplate(target.template, message, connection.id) }
        : { text: message.subject ? `${message.subject}\n\n${message.text}` : message.text };
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN", false, { connectionId: connection.id })), options.sendTimeoutMs ?? 45000);
      });
      try {
        const sent = await Promise.race([transport.send(credentials, target.recipient, outbound), timeout]);
        return {
          ...(sent.messageId !== undefined ? { providerMessageId: sent.messageId } : {}),
          submittedAt: new Date().toISOString(),
          ...(sent.messageId === undefined ? { warnings: ["CHANNEL_RESPONSE_UNPARSEABLE"] } : {}),
        };
      } catch (error) {
        throw classifyWhatsappError(error, connection.id);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

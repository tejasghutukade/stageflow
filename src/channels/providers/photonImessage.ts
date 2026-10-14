import { z } from "zod";
import { ChannelError } from "../errors.js";
import { httpCall, parseJson, statusFailure } from "../http.js";
import type { ChannelProvider, ConnectionHealth, OutboundMessage, ResolvedConnection, SendContext, SendReceipt } from "../types.js";

export type PhotonImessageConfig = Record<string, never>;
export type PhotonImessageTarget = { recipient: string };
export type PhotonCredentials = { projectId: string; projectSecret: string };

/** Sends one iMessage text. Implementations throw `ChannelError` for failures they can classify. */
export interface PhotonImessageTransport {
  sendText(credentials: PhotonCredentials, recipient: string, text: string): Promise<{ messageId?: string }>;
}

export const PHOTON_BASE_URL = "https://spectrum.photon.codes";

const e164 = /^\+[1-9]\d{6,14}$/;
const email = /^[^\s@<>,;]+@[^\s@<>,;]+$/;
const targetSchema = z.object({ to: z.string().max(320).refine(value => e164.test(value) || email.test(value)) }).strict();

export type PhotonImessageOptions = {
  fetch?: typeof fetch;
  baseUrl?: string;
  transport?: PhotonImessageTransport;
  sendTimeoutMs?: number;
  checkTimeoutMs?: number;
};

export function credentialsOf(connection: ResolvedConnection<unknown>): PhotonCredentials {
  const secrets = connection.credential?.secrets;
  if (!secrets?.projectId || !secrets.projectSecret) throw new ChannelError("CHANNEL_SECRET_UNAVAILABLE", false, { connectionId: connection.id });
  return { projectId: secrets.projectId, projectSecret: secrets.projectSecret };
}

export function photonHeaders({ projectId, projectSecret }: PhotonCredentials): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${projectId}:${projectSecret}`).toString("base64")}`, accept: "application/json" };
}

function containsString(value: unknown, wanted: string): boolean {
  if (typeof value === "string") return value.toLowerCase() === wanted.toLowerCase();
  if (Array.isArray(value)) return value.some(item => containsString(item, wanted));
  if (value && typeof value === "object") return Object.values(value).some(item => containsString(item, wanted));
  return false;
}

/** Maps what the Spectrum SDK throws. Unclassified errors may have happened after the send, so they are unknown. */
export function classifySdkError(error: unknown, connectionId: string): ChannelError {
  if (error instanceof ChannelError) return error;
  const detail = { connectionId };
  const status = (error as { status?: unknown } | null)?.status;
  const message = error instanceof Error ? error.message : "";
  if (/target not allowed/i.test(message)) return new ChannelError("CHANNEL_RECIPIENT_REJECTED", false, detail);
  if (status === 401) return new ChannelError("CHANNEL_AUTH_FAILED", false, detail);
  if (status === 403) return new ChannelError("CHANNEL_UNAUTHORIZED", false, detail);
  if (status === 429) return new ChannelError("CHANNEL_RATE_LIMIT", true, detail);
  return new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN", false, detail);
}

/**
 * Loads `spectrum-ts` on first use, so a host that never sends iMessage does not need it. The
 * app is created for one send and stopped in `finally`: nothing keeps a connection open, whether
 * or not the SDK opens inbound streams while it is alive.
 */
export function spectrumTransport(importer: (specifier: string) => Promise<any> = specifier => import(specifier)): PhotonImessageTransport {
  return {
    async sendText({ projectId, projectSecret }, recipient, text) {
      let core: any;
      let provider: any;
      try {
        core = await importer("spectrum-ts");
        provider = await importer("@spectrum-ts/imessage");
      } catch {
        throw new ChannelError("CHANNEL_PROVIDER_UNSUPPORTED");
      }
      const app = await core.Spectrum({ projectId, projectSecret, providers: [provider.imessage.config()] });
      try {
        const im = provider.imessage(app);
        const user = await im.user(recipient);
        const space = await im.space.create(user);
        const sent = await space.send(text);
        const id = sent?.id;
        return typeof id === "string" ? { messageId: id } : {};
      } finally {
        await app.stop().catch(() => undefined);
      }
    },
  };
}

/**
 * iMessage through a Photon (Spectrum) project, DM only. Credentials come from a shared `photon`
 * credential. Free and Pro projects can message only users registered in the project, which the
 * target check looks up; Stageflow never registers users. Receiving is not part of this phase.
 */
export function createPhotonImessageProvider(options: PhotonImessageOptions = {}): ChannelProvider<PhotonImessageConfig, PhotonImessageTarget> {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl ?? PHOTON_BASE_URL;
  const transport = options.transport ?? spectrumTransport();
  const failed = (failure: ChannelError, checkedAt: string): ConnectionHealth =>
    ({ state: "failed", checkedAt, error: { code: failure.code, retryable: failure.retryable } });

  return {
    id: "imessage",
    operations: ["send"],
    secrets: { required: [] },
    credentialProvider: "photon",
    validateConfig(config) {
      const parsed = z.object({}).strict().safeParse(config);
      return parsed.success ? { ok: true, value: {} } : { ok: false, issues: ["config"] };
    },
    validateTarget(target) {
      const parsed = targetSchema.safeParse(target);
      return parsed.success ? { ok: true, value: { recipient: parsed.data.to } } : { ok: false, issues: parsed.error.issues.map(issue => issue.path.join(".") || "target") };
    },
    async check(connection, signal): Promise<ConnectionHealth> {
      const checkedAt = new Date().toISOString();
      try {
        const credentials = credentialsOf(connection);
        const result = await httpCall({
          fetch: doFetch, url: `${base}/projects/${encodeURIComponent(credentials.projectId)}/imessage/tokens`, method: "POST",
          headers: photonHeaders(credentials), body: {}, timeoutMs: options.checkTimeoutMs ?? 10000, signal, mode: "check", connectionId: connection.id,
        });
        return result.status >= 200 && result.status < 300 ? { state: "ok", checkedAt } : failed(statusFailure(result.status, "check", connection.id), checkedAt);
      } catch (error) {
        return failed(error instanceof ChannelError ? error : new ChannelError("CHANNEL_CONNECTION_FAILED", true), checkedAt);
      }
    },
    async checkTargets(connection, targets, signal): Promise<ConnectionHealth> {
      const checkedAt = new Date().toISOString();
      try {
        const credentials = credentialsOf(connection);
        const project = encodeURIComponent(credentials.projectId);
        const tokens = await httpCall({
          fetch: doFetch, url: `${base}/projects/${project}/imessage/tokens`, method: "POST", headers: photonHeaders(credentials), body: {},
          timeoutMs: options.checkTimeoutMs ?? 10000, signal, mode: "check", connectionId: connection.id,
        });
        if (tokens.status < 200 || tokens.status >= 300) return failed(statusFailure(tokens.status, "check", connection.id), checkedAt);
        const type = (parseJson(tokens.text) as { type?: unknown } | undefined)?.type;
        if (type === "dedicated") return { state: "ok", checkedAt };
        for (const target of targets) {
          const found = await httpCall({
            fetch: doFetch, url: `${base}/projects/${project}/users/?search=${encodeURIComponent(target.recipient)}`, method: "GET",
            headers: photonHeaders(credentials), timeoutMs: options.checkTimeoutMs ?? 10000, signal, mode: "check", connectionId: connection.id,
          });
          if (found.status < 200 || found.status >= 300) return failed(statusFailure(found.status, "check", connection.id), checkedAt);
          if (!containsString(parseJson(found.text), target.recipient)) {
            return failed(new ChannelError("CHANNEL_RECIPIENT_REJECTED", false, { connectionId: connection.id }), checkedAt);
          }
        }
        return { state: "ok", checkedAt };
      } catch (error) {
        return failed(error instanceof ChannelError ? error : new ChannelError("CHANNEL_CONNECTION_FAILED", true), checkedAt);
      }
    },
    async send(connection, target, message: OutboundMessage, _context: SendContext): Promise<SendReceipt> {
      const credentials = credentialsOf(connection);
      const text = message.subject ? `${message.subject}\n\n${message.text}` : message.text;
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ChannelError("CHANNEL_SEND_OUTCOME_UNKNOWN", false, { connectionId: connection.id })), options.sendTimeoutMs ?? 45000);
      });
      try {
        const sent = await Promise.race([transport.sendText(credentials, target.recipient, text), timeout]);
        return {
          ...(sent.messageId !== undefined ? { providerMessageId: sent.messageId } : {}),
          submittedAt: new Date().toISOString(),
          ...(sent.messageId === undefined ? { warnings: ["CHANNEL_RESPONSE_UNPARSEABLE"] } : {}),
        };
      } catch (error) {
        throw classifySdkError(error, connection.id);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

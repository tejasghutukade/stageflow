import { z } from "zod";
import { ChannelError } from "../errors.js";
import { httpCall, parseJson, statusFailure } from "../http.js";
import { healthOf, importModule, receiptFor, withSendTimeout, withSpectrumApp, zodValidator, type SpectrumImporter } from "./kit.js";
import type { ChannelProvider, OutboundMessage, ProviderField, ProviderMeta, ResolvedConnection, SendContext, SendReceipt } from "../types.js";

export type PhotonImessageConfig = Record<string, never>;
export type PhotonImessageTarget = { recipient: string };
export type PhotonCredentials = { projectId: string; projectSecret: string };

/** Sends one iMessage text. Implementations throw `ChannelError` for failures they can classify. */
export interface PhotonImessageTransport {
  sendText(credentials: PhotonCredentials, recipient: string, text: string): Promise<{ messageId?: string }>;
}

export const PHOTON_BASE_URL = "https://spectrum.photon.codes";

export const PHOTON_FIELDS: ProviderField[] = [
  { key: "projectId", label: "Photon project ID", hint: "Project settings in app.photon.codes", target: "credential", input: "password", required: true, placeholder: "3f9c21aa-..." },
  { key: "projectSecret", label: "Photon project secret", hint: "Stored on this host. Never written to connections.yaml.", target: "credential", input: "password", required: true },
];

export const PHOTON_CREDENTIAL_YAML = `credentials:
  - id: photon-main
    provider: photon
    secrets:
      projectId: env:PHOTON_PROJECT_ID
      projectSecret: env:PHOTON_PROJECT_SECRET
`;

export const IMESSAGE_META: ProviderMeta = {
  label: "iMessage",
  blurb: "Not connected · via Photon",
  icon: "message-circle",
  via: "Photon",
  note: "Sending iMessage uses the Spectrum SDK packages (optional dependencies). On a Free or Pro Photon project, each recipient must be a project user and must text their assigned line once before Stageflow can message them.",
  fields: PHOTON_FIELDS,
  recipient: { label: "Recipient", placeholder: "+14155550123 or an Apple ID email", multiple: false, cc: false, template: false },
  envNames: ["PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET"],
  yamlExample: `${PHOTON_CREDENTIAL_YAML}connections:
  - id: alerts-imessage
    provider: imessage
    credential: photon-main
`,
  stageExample: '    to: "+14155550123"',
};

const e164 = /^\+[1-9]\d{6,14}$/;
const email = /^[^\s@<>,;]+@[^\s@<>,;]+$/;
const targetSchema = z.object({ to: z.string().max(320).refine(value => e164.test(value) || email.test(value)) }).strict();

const validateConfig = zodValidator(z.object({}).strict(), "config", (): PhotonImessageConfig => ({}));
const validateTarget = zodValidator(targetSchema, "target", (data): PhotonImessageTarget => ({ recipient: data.to }));

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

/** Photon wraps responses as `{ succeed, data }`. Older shapes without the wrapper are still read. */
export function photonData(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== "object") return undefined;
  const wrapped = (body as { data?: unknown }).data;
  return wrapped && typeof wrapped === "object" ? (wrapped as Record<string, unknown>) : (body as Record<string, unknown>);
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
 * The Spectrum SDK send for iMessage. The lifecycle (lazy import, create, stop) is shared with
 * WhatsApp in `withSpectrumApp`.
 */
export function spectrumTransport(importer: SpectrumImporter = importModule): PhotonImessageTransport {
  return {
    sendText: (credentials, recipient, text) => withSpectrumApp(importer, credentials, { pkg: "@spectrum-ts/imessage", exportName: "imessage" }, async ({ platform }) => {
      const user = await platform.user(recipient);
      const space = await platform.space.create(user);
      const sent = await space.send(text);
      return typeof sent?.id === "string" ? { messageId: sent.id } : {};
    }),
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
  return {
    id: "imessage",
    meta: IMESSAGE_META,
    operations: ["send"],
    secrets: { required: [] },
    credentialProvider: "photon",
    validateConfig,
    validateTarget,
    check: (connection, signal) => healthOf(async () => {
      const credentials = credentialsOf(connection);
      const result = await httpCall({
        fetch: doFetch, url: `${base}/projects/${encodeURIComponent(credentials.projectId)}/imessage/tokens`, method: "POST",
        headers: photonHeaders(credentials), body: {}, timeoutMs: options.checkTimeoutMs ?? 10000, signal, mode: "check", connectionId: connection.id,
      });
      if (result.status < 200 || result.status >= 300) throw statusFailure(result.status, "check", connection.id);
    }),
    checkTargets: (connection, targets, signal) => healthOf(async () => {
      const credentials = credentialsOf(connection);
      const project = encodeURIComponent(credentials.projectId);
      const call = (url: string, init: { method: "GET" | "POST"; body?: unknown }) => httpCall({
        fetch: doFetch, url, method: init.method, headers: photonHeaders(credentials), ...(init.body !== undefined ? { body: init.body } : {}),
        timeoutMs: options.checkTimeoutMs ?? 10000, signal, mode: "check", connectionId: connection.id,
      });
      const tokens = await call(`${base}/projects/${project}/imessage/tokens`, { method: "POST", body: {} });
      if (tokens.status < 200 || tokens.status >= 300) throw statusFailure(tokens.status, "check", connection.id);
      if (photonData(parseJson(tokens.text))?.type === "dedicated") return;
      for (const target of targets) {
        const found = await call(`${base}/projects/${project}/users/?search=${encodeURIComponent(target.recipient)}`, { method: "GET" });
        if (found.status < 200 || found.status >= 300) throw statusFailure(found.status, "check", connection.id);
        if (!containsString(parseJson(found.text), target.recipient)) throw new ChannelError("CHANNEL_RECIPIENT_REJECTED", false, { connectionId: connection.id });
      }
    }),
    async contact(connection, signal) {
      try {
        const credentials = credentialsOf(connection);
        const project = encodeURIComponent(credentials.projectId);
        const call = (url: string, init: { method: "GET" | "POST"; body?: unknown }) => httpCall({
          fetch: doFetch, url, method: init.method, headers: photonHeaders(credentials), ...(init.body !== undefined ? { body: init.body } : {}),
          timeoutMs: options.checkTimeoutMs ?? 10000, ...(signal ? { signal } : {}), mode: "check", connectionId: connection.id,
        });
        const tokens = await call(`${base}/projects/${project}/imessage/tokens`, { method: "POST", body: {} });
        if (tokens.status < 200 || tokens.status >= 300) return { ok: false, error: `Photon answered ${tokens.status}` };
        const data = photonData(parseJson(tokens.text));
        if (data?.type === "dedicated") {
          const numbers = Object.values((data.numbers ?? {}) as Record<string, unknown>).filter((value): value is string => typeof value === "string");
          return { ok: true, kind: "dedicated", numbers: [...new Set(numbers)] };
        }
        const users = await call(`${base}/projects/${project}/users/?type=shared&limit=500`, { method: "GET" });
        if (users.status < 200 || users.status >= 300) return { ok: false, error: `Photon answered ${users.status}` };
        const list = (photonData(parseJson(users.text))?.users ?? []) as Array<Record<string, unknown>>;
        return {
          ok: true,
          kind: "shared",
          users: list
            .filter((user) => typeof user.phoneNumber === "string")
            .map((user) => ({
              phone: user.phoneNumber as string,
              assignedNumber: typeof user.assignedPhoneNumber === "string" ? user.assignedPhoneNumber : null,
              name: [user.firstName, user.lastName].filter((part): part is string => typeof part === "string" && part.length > 0).join(" ") || null,
            })),
        };
      } catch {
        return { ok: false, error: "Could not reach Photon" };
      }
    },
    async send(connection, target, message: OutboundMessage, _context: SendContext): Promise<SendReceipt> {
      const credentials = credentialsOf(connection);
      const text = message.subject ? `${message.subject}\n\n${message.text}` : message.text;
      try {
        const sent = await withSendTimeout(options.sendTimeoutMs ?? 45000, connection.id, transport.sendText(credentials, target.recipient, text));
        return receiptFor(sent.messageId);
      } catch (error) {
        throw classifySdkError(error, connection.id);
      }
    },
  };
}

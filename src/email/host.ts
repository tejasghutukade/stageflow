import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { EmailAccounts } from "./accounts.js";
import { LocalEmailAdapter } from "./adapter.js";
import { EmailError, type EmailMailbox, type ReplyToEmailInput, type SendEmailInput, type SendEmailResult, type EmailMessageRef, type EmailMessage, type SearchEmailsInput, type SearchEmailsResult, type EmailArtifactContext, type DownloadEmailAttachmentInput, type DownloadEmailAttachmentResult } from "./port.js";
import type { StageConfig } from "../types/stage.js";

const hosts = new Map<string, { accounts: EmailAccounts; mailbox: LocalEmailAdapter; releasing?: Promise<void> }>();
export function emailHostFor(cwd: string): { accounts: EmailAccounts; mailbox: LocalEmailAdapter } {
  const key = path.resolve(cwd);
  let host = hosts.get(key);
  if (host?.releasing) throw new EmailError("EMAIL_CONNECTION_FAILED", true);
  if (!host) {
    const accounts = new EmailAccounts(key);
    host = { accounts, mailbox: new LocalEmailAdapter(accounts) };
    hosts.set(key, host);
  }
  return host;
}
export async function releaseEmailHost(cwd: string): Promise<void> {
  const key = path.resolve(cwd);
  const host = hosts.get(key);
  if (!host) return;
  host.releasing ??= host.mailbox.stop();
  await host.releasing;
  if (hosts.get(key) === host) hosts.delete(key);
}
export type StageEmail = Pick<EmailMailbox, "send" | "reply" | "search" | "getMessage" | "downloadAttachment">;
export function validateStageEmailAccounts(accounts: EmailAccounts, stage: StageConfig): void {
  for (const permission of stage.email ?? []) accounts.get(permission.accountId);
}
export function stageEmail(mailbox: EmailMailbox, stage: StageConfig, runId: string, context?: Omit<EmailArtifactContext, "stageId">): StageEmail {
  const permissions = structuredClone(stage.email ?? []);
  const stageId = stage.id;
  const artifacts = context ? { ...context, stageId } : undefined;
  function authorize(accountId: string, operation: "send" | "reply" | "search" | "getMessage" | "downloadAttachment"): void {
    if (!permissions.some(permission => permission.accountId === accountId && permission.operations.includes(operation))) {
      throw new EmailError("EMAIL_UNAUTHORIZED");
    }
  }
  function operationKey(key: string): string {
    if (typeof key !== "string" || !key.length || key.length > 120) throw new EmailError("EMAIL_INVALID_INPUT");
    return createHash("sha256").update(JSON.stringify([runId, stageId, key])).digest("hex");
  }
  return {
    async search(input) {
      authorize(input?.accountId, "search");
      return mailbox.search(input);
    },
    async getMessage(ref) {
      authorize(ref?.accountId, "getMessage");
      return mailbox.getMessage(ref);
    },
    async send(input) {
      authorize(input?.accountId, "send");
      return mailbox.send({ ...input, operationKey: operationKey(input.operationKey) }, artifacts);
    },
    async reply(input) {
      authorize(input?.ref?.accountId, "reply");
      return mailbox.reply({ ...input, operationKey: operationKey(input.operationKey) }, artifacts);
    },
    async downloadAttachment(input) {
      authorize(input?.ref?.accountId, "downloadAttachment");
      return mailbox.downloadAttachment(input, artifacts);
    },
  };
}
export function emailWorkerEnvironment(env: NodeJS.ProcessEnv, accounts: EmailAccounts): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const account of accounts.list()) for (const connection of [account.imap, account.smtp]) {
    if (connection.auth.secretRef.startsWith("env:")) delete result[connection.auth.secretRef.slice(4)];
  }
  return result;
}

/** The inherited IPC channel identifies the child; no caller-provided run or stage identity is accepted. */
export function workerStageEmail(): StageEmail {
  function request<T>(operation: "send" | "reply" | "search" | "getMessage" | "downloadAttachment", input: SendEmailInput | ReplyToEmailInput | SearchEmailsInput | EmailMessageRef | DownloadEmailAttachmentInput): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!process.connected || !process.send) { reject(new EmailError("EMAIL_UNAUTHORIZED")); return; }
      const requestId = randomUUID();
      const finish = (error?: EmailError, result?: T): void => {
        clearTimeout(timer); process.off("message", receive); process.off("disconnect", disconnected);
        if (error) reject(error); else resolve(result!);
      };
      const submitting = operation === "send" || operation === "reply";
      const disconnected = (): void => finish(new EmailError(submitting ? "EMAIL_SEND_OUTCOME_UNKNOWN" : "EMAIL_CONNECTION_FAILED", !submitting));
      const receive = (message: unknown): void => {
        const response = message as { type?: string; requestId?: string; receipt?: T; result?: T; error?: { code: EmailError["code"]; retryable: boolean; unsupportedFields?: string[] } };
        if (response?.type !== "email.response" || response.requestId !== requestId) return;
        finish(response.error ? new EmailError(response.error.code, response.error.retryable, response.error.unsupportedFields) : undefined, response.result ?? response.receipt);
      };
      const timer = setTimeout(disconnected, 65000);
      process.on("message", receive); process.once("disconnect", disconnected);
      process.send({ type: `email.${operation}`, requestId, input }, error => { if (error) disconnected(); });
    });
  }
  return {
    send(input) { return request<SendEmailResult>("send", input); },
    reply(input) { return request<SendEmailResult>("reply", input); },
    search(input) { return request<SearchEmailsResult>("search", input); },
    getMessage(ref) { return request<EmailMessage>("getMessage", ref); },
    downloadAttachment(input) { return request<DownloadEmailAttachmentResult>("downloadAttachment", input); },
  };
}

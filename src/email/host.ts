import path from "node:path";
import { randomUUID } from "node:crypto";
import { EmailAccounts } from "./accounts.js";
import { LocalEmailAdapter } from "./adapter.js";
import { EmailError, type EmailMailbox, type SendEmailInput, type SendEmailResult, type EmailMessageRef, type EmailMessage, type SearchEmailsInput, type SearchEmailsResult } from "./port.js";
import type { StageConfig } from "../types/stage.js";

const hosts = new Map<string, { accounts: EmailAccounts; mailbox: LocalEmailAdapter }>();
export function emailHostFor(cwd: string): { accounts: EmailAccounts; mailbox: LocalEmailAdapter } {
  const key = path.resolve(cwd);
  let host = hosts.get(key);
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
  hosts.delete(key);
  await host?.mailbox.stop();
}
export type StageEmail = Pick<EmailMailbox, "send" | "search" | "getMessage">;
export function validateStageEmailAccounts(accounts: EmailAccounts, stage: StageConfig): void {
  for (const permission of stage.email ?? []) accounts.get(permission.accountId);
}
export function stageEmail(mailbox: EmailMailbox, stage: StageConfig, runId: string): StageEmail {
  const permissions = structuredClone(stage.email ?? []);
  const stageId = stage.id;
  function authorize(accountId: string, operation: "send" | "search" | "getMessage"): void {
    if (!permissions.some(permission => permission.accountId === accountId && permission.operations.includes(operation))) {
      throw new EmailError("EMAIL_UNAUTHORIZED");
    }
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
      if (typeof input.operationKey !== "string" || !input.operationKey.length || input.operationKey.length > 120) throw new EmailError("EMAIL_INVALID_INPUT");
      // A stage cannot collide with another stage's receipt keys.
      return mailbox.send({ ...input, operationKey: `${runId}:${stageId}:${input.operationKey}` });
    },
  };
}
export function emailWorkerEnvironment(env: NodeJS.ProcessEnv, accounts: EmailAccounts): NodeJS.ProcessEnv {
  const result = { ...env };
  for (const account of accounts.list()) for (const connection of [account.imap, account.smtp]) delete result[connection.auth.secretRef.slice(4)];
  return result;
}

/** The inherited IPC channel identifies the child; no caller-provided run or stage identity is accepted. */
export function workerStageEmail(): StageEmail {
  function request<T>(operation: "send" | "search" | "getMessage", input: SendEmailInput | SearchEmailsInput | EmailMessageRef): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!process.connected || !process.send) { reject(new EmailError("EMAIL_UNAUTHORIZED")); return; }
      const requestId = randomUUID();
      const finish = (error?: EmailError, result?: T): void => {
        clearTimeout(timer); process.off("message", receive); process.off("disconnect", disconnected);
        if (error) reject(error); else resolve(result!);
      };
      const disconnected = (): void => finish(new EmailError(operation === "send" ? "EMAIL_SEND_OUTCOME_UNKNOWN" : "EMAIL_CONNECTION_FAILED", operation !== "send"));
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
    search(input) { return request<SearchEmailsResult>("search", input); },
    getMessage(ref) { return request<EmailMessage>("getMessage", ref); },
  };
}

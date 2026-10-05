import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { EmailAccounts, resolveEmailSecret, type EmailAccount, type EmailConnection } from "./accounts.js";
import {
  EmailError, type EmailMailbox, type EmailEventSource, type EmailAccountStatus,
  type EmailConnectionStatus, type EmailMessageRef, type EmailMessage, type SendEmailInput,
  type SendEmailResult, type ReplyToEmailInput, type SearchEmailsInput, type SearchEmailsResult,
  type EmailReceivedEvent,
} from "./port.js";

function normalizedConnectionError(error: unknown): EmailError {
  if (error instanceof EmailError) return error;
  const fault = error as { code?: string; authenticationFailed?: boolean; responseCode?: number };
  if (fault.authenticationFailed || fault.code === "EAUTH" || fault.responseCode === 535) {
    return new EmailError("EMAIL_AUTH_FAILED");
  }
  if (["ETIMEDOUT", "ETIMEOUT"].includes(fault.code ?? "")) return new EmailError("EMAIL_TIMEOUT", true);
  return new EmailError("EMAIL_CONNECTION_FAILED", true);
}

function connectionStatus(error?: unknown): EmailConnectionStatus {
  if (!error) return { state: "ok" };
  const normalized = normalizedConnectionError(error);
  return { state: "failed", error: { code: normalized.code, retryable: normalized.retryable } };
}

/** Both adapters validate account scope before any operation, including unsupported operations. */
export abstract class AccountEmailAdapter implements EmailMailbox, EmailEventSource {
  constructor(protected readonly accounts: EmailAccounts) {}
  abstract testAccount(accountId: string, protocol?: "imap" | "smtp" | "both"): Promise<EmailAccountStatus>;

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    return this.unsupported(input.accountId);
  }
  async reply(input: ReplyToEmailInput): Promise<SendEmailResult> {
    return this.unsupported(input.ref.accountId);
  }
  async getMessage(ref: EmailMessageRef): Promise<EmailMessage> {
    return this.unsupported(ref.accountId);
  }
  async search(input: SearchEmailsInput): Promise<SearchEmailsResult> {
    return this.unsupported(input.accountId);
  }
  async start(_emit: (event: EmailReceivedEvent) => Promise<void>): Promise<void> {
    throw new EmailError("EMAIL_UNSUPPORTED");
  }
  async stop(): Promise<void> {}

  protected unsupported(accountId: string): never {
    this.accounts.get(accountId);
    throw new EmailError("EMAIL_UNSUPPORTED");
  }
  protected status(accountId: string): EmailAccountStatus {
    return {
      accountId, checkedAt: new Date().toISOString(),
      capabilities: { operations: ["testAccount"], searchFields: [], idle: false },
    };
  }
}

export class InMemoryEmailAdapter extends AccountEmailAdapter {
  async testAccount(accountId: string, protocol: "imap" | "smtp" | "both" = "both"): Promise<EmailAccountStatus> {
    if (!["imap", "smtp", "both"].includes(protocol)) throw new EmailError("EMAIL_INVALID_INPUT");
    this.accounts.get(accountId);
    const status = this.status(accountId);
    if (protocol !== "smtp") status.imap = { state: "ok" };
    if (protocol !== "imap") status.smtp = { state: "ok" };
    this.accounts.recordHealth(status);
    return status;
  }
}

export class LocalEmailAdapter extends AccountEmailAdapter {
  private readonly active = new Map<string, Set<() => void>>();
  private readonly unsubscribe: () => void;

  constructor(accounts: EmailAccounts, private readonly env: NodeJS.ProcessEnv = process.env) {
    super(accounts);
    this.unsubscribe = accounts.onChange(accountId => this.cancel(accountId));
  }

  async testAccount(accountId: string, protocol: "imap" | "smtp" | "both" = "both"): Promise<EmailAccountStatus> {
    if (!["imap", "smtp", "both"].includes(protocol)) throw new EmailError("EMAIL_INVALID_INPUT");
    const account = this.accounts.get(accountId);
    const status = this.status(accountId);
    const tests: Promise<void>[] = [];
    if (protocol !== "smtp") tests.push(this.testImap(account).then(result => {
      status.imap = result.status;
      status.capabilities.idle = result.idle;
    }));
    if (protocol !== "imap") tests.push(this.testSmtp(account).then(result => { status.smtp = result; }));
    await Promise.all(tests);
    // Updates cancel tests. Never publish an old result for a new account configuration.
    if (JSON.stringify(this.accounts.get(accountId)) !== JSON.stringify(account)) {
      throw new EmailError("EMAIL_CONNECTION_FAILED", true);
    }
    this.accounts.recordHealth(status);
    return status;
  }

  async stop(): Promise<void> {
    for (const accountId of this.active.keys()) this.cancel(accountId);
    this.unsubscribe();
  }

  private cancel(accountId: string): void {
    for (const cancel of this.active.get(accountId) ?? []) cancel();
  }

  private async bounded<T>(account: EmailAccount, close: () => void, work: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () => {
        close();
        reject(new EmailError("EMAIL_CONNECTION_FAILED", true));
      };
      timer = setTimeout(() => {
        close();
        reject(new EmailError("EMAIL_TIMEOUT", true));
      }, account.connectionTimeoutMs);
    });
    const active = this.active.get(account.accountId) ?? new Set();
    this.active.set(account.accountId, active);
    active.add(cancel);
    try {
      return await Promise.race([work(), cancelled]);
    } finally {
      clearTimeout(timer);
      close();
      active.delete(cancel);
      if (active.size === 0) this.active.delete(account.accountId);
    }
  }

  private async testImap(account: EmailAccount): Promise<{ status: EmailConnectionStatus; idle: boolean }> {
    let client: ImapFlow | undefined;
    try {
      const config = account.imap;
      const secret = resolveEmailSecret(config, this.env);
      client = new ImapFlow({
        host: config.host, port: config.port, secure: config.tls === "implicit",
        doSTARTTLS: config.tls === "starttls", logger: false,
        auth: { user: config.username, ...(config.auth.type === "oauth2" ? { accessToken: secret } : { pass: secret }) },
        connectionTimeout: account.connectionTimeoutMs, greetingTimeout: account.connectionTimeoutMs,
        socketTimeout: account.connectionTimeoutMs, tls: { rejectUnauthorized: true },
      });
      client.on("error", () => {});
      const connection = client;
      await this.bounded(account, () => connection.close(), () => connection.connect());
      return { status: connectionStatus(), idle: client.capabilities.has("IDLE") };
    } catch (error) {
      return { status: connectionStatus(error), idle: false };
    }
  }

  private async testSmtp(account: EmailAccount): Promise<EmailConnectionStatus> {
    let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
    let socket: Socket | undefined;
    try {
      const config: EmailConnection = account.smtp;
      const secret = resolveEmailSecret(config, this.env);
      const options: SMTPTransport.Options = {
        host: config.host, port: config.port, forceAuth: true,
        secure: config.tls === "implicit", requireTLS: config.tls === "starttls",
        ignoreTLS: config.tls === "none", logger: false, debug: false,
        connectionTimeout: account.connectionTimeoutMs, greetingTimeout: account.connectionTimeoutMs,
        socketTimeout: account.connectionTimeoutMs, tls: { rejectUnauthorized: true },
        auth: config.auth.type === "oauth2"
          ? { type: "OAuth2", user: config.username, accessToken: secret }
          : { user: config.username, pass: secret },
        getSocket: (_options, callback) => {
          let settled = false;
          const failed = (error: Error): void => {
            if (settled) return;
            settled = true;
            callback(error);
          };
          const connected = (): void => {
            if (settled) return;
            settled = true;
            callback(null, { connection: socket!, secured: config.tls === "implicit" });
          };
          if (config.tls === "implicit") {
            socket = connectTls({ host: config.host, port: config.port, rejectUnauthorized: true,
              servername: config.host }, connected);
          } else {
            socket = connectTcp({ host: config.host, port: config.port }, connected);
          }
          socket.once("error", failed);
        },
      };
      transport = nodemailer.createTransport(options);
      const connection = transport;
      await this.bounded(account, () => {
        socket?.destroy();
        connection.close();
      }, () => connection.verify());
      return connectionStatus();
    } catch (error) {
      return connectionStatus(error);
    } finally {
      socket?.destroy();
      transport?.close();
    }
  }
}

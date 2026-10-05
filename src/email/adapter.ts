import { ImapFlow } from "imapflow";
import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import { EmailSubmissions, validateSend } from "./submissions.js";
import { replyMessage, validateReply } from "./replies.js";
import { decodeRef, decodeCursor, EMAIL_SOURCE_LIMIT, EMAIL_SEARCH_FIELDS, envelopeSummary, matchesSearch, parseMessage, searchCursor, searchQuery, summarize, type MailRecord, type MailQuery } from "./messages.js";
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
  readonly submissions: EmailSubmissions;
  protected readonly cursorKey = randomBytes(32);
  constructor(protected readonly accounts: EmailAccounts) {
    this.submissions = new EmailSubmissions(accounts.scope);
  }
  abstract testAccount(accountId: string, protocol?: "imap" | "smtp" | "both"): Promise<EmailAccountStatus>;

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const account = this.accounts.get(input?.accountId);
    const validated = validateSend(input, account);
    return this.sendValidated(account, validated);
  }
  private sendValidated(account: EmailAccount, validated: SendEmailInput, identity?: unknown): Promise<SendEmailResult> {
    return this.submissions.send(validated, operationId => {
      if (JSON.stringify(this.accounts.get(account.accountId)) !== JSON.stringify(account)) throw new EmailError("EMAIL_CONNECTION_FAILED", true);
      return this.submit(account, validated, operationId);
    }, identity);
  }
  protected abstract submit(account: EmailAccount, input: SendEmailInput, operationId: string): Promise<SendEmailResult>;
  async reply(input: ReplyToEmailInput): Promise<SendEmailResult> {
    const account = this.accounts.get(input?.ref?.accountId);
    const validated = validateReply(input);
    const original = await this.getMessage(validated.ref);
    const message = validateSend(replyMessage(account, original, validated), account);
    return this.sendValidated(account, message, { operation: "reply", ref: original.ref, replyAll: validated.replyAll });
  }
  abstract getMessage(ref: EmailMessageRef): Promise<EmailMessage>;
  abstract search(input: SearchEmailsInput): Promise<SearchEmailsResult>;
  async start(_emit: (event: EmailReceivedEvent) => Promise<void>): Promise<void> {
    throw new EmailError("EMAIL_UNSUPPORTED");
  }
  async stop(): Promise<void> {}

  protected searchPosition(uid: number, high: number, last: number | undefined, query: MailQuery): boolean {
    return uid <= high && (last === undefined || (query.sort === "newest" ? uid < last : uid > last));
  }
  protected status(accountId: string): EmailAccountStatus {
    return {
      accountId, checkedAt: new Date().toISOString(),
      capabilities: { operations: ["testAccount", "send", "reply", "search", "getMessage"], searchFields: [...EMAIL_SEARCH_FIELDS], idle: false },
    };
  }
}

export class InMemoryEmailAdapter extends AccountEmailAdapter {
  private readonly mailboxes = new Map<string, { generation: string; messages: MailRecord[] }>();
  /** Provider fixture data. Content is held only by this test adapter. */
  seedMailbox(accountId: string, messages: MailRecord[], mailbox = "INBOX", generation = "1"): void {
    this.accounts.get(accountId);
    this.mailboxes.set(`${accountId}:${mailbox}`, { generation, messages: messages.map(value => ({ ...value, source: Buffer.from(value.source), flags: new Set(value.flags), receivedAt: new Date(value.receivedAt) })) });
  }
  async search(input: SearchEmailsInput): Promise<SearchEmailsResult> {
    const account = this.accounts.get(input?.accountId);
    const query = searchQuery(input);
    const { mailbox } = query;
    const stored = this.mailboxes.get(`${account.accountId}:${mailbox}`);
    if (!stored && mailbox !== "INBOX") throw new EmailError("EMAIL_INVALID_INPUT");
    const generation = stored?.generation ?? "1";
    const cursor = decodeCursor(account, query, generation, input.cursor, this.cursorKey);
    const high = cursor?.high ?? Math.max(0, ...stored?.messages.map(value => value.uid) ?? []);
    const records = [...stored?.messages ?? []].sort((a, b) => query.sort === "newest" ? b.uid - a.uid : a.uid - b.uid);
    let inspected = 0;
    const messages = [];
    let last = 0;
    for (const record of records) {
      if (!this.searchPosition(record.uid, high, cursor?.last, query)) continue;
      if (++inspected > account.searchWorkLimit) throw new EmailError("EMAIL_RESOURCE_LIMIT");
      const end = record.source.indexOf("\r\n\r\n");
      const headers = record.source.subarray(0, end < 0 ? Math.min(record.source.length, 65536) : Math.min(end + 4, 65536));
      const summary = summarize(await parseMessage(account, mailbox, generation, { ...record, source: headers }));
      delete summary.hasAttachments; delete summary.preview;
      if (!matchesSearch(summary, query)) continue;
      if (messages.length === query.limit) return { messages, nextCursor: searchCursor(account, query, generation, high, last, this.cursorKey) };
      messages.push(summary);
      last = record.uid;
    }
    return { messages };
  }
  async getMessage(ref: EmailMessageRef): Promise<EmailMessage> {
    const account = this.accounts.get(ref?.accountId);
    const decoded = decodeRef(account, ref);
    const stored = this.mailboxes.get(`${account.accountId}:${decoded.mailbox}`);
    if (!stored || stored.generation !== decoded.generation) throw new EmailError("EMAIL_STALE_REFERENCE");
    const record = stored.messages.find(value => value.uid === decoded.uid);
    if (!record) throw new EmailError("EMAIL_MESSAGE_NOT_FOUND");
    return parseMessage(account, decoded.mailbox, stored.generation, record);
  }
  readonly sent: SendEmailInput[] = [];
  protected async submit(_account: EmailAccount, input: SendEmailInput, operationId: string): Promise<SendEmailResult> {
    this.sent.push(structuredClone(input));
    return { operationId, messageId: `<${operationId}@stageflow>`, accepted: [...input.to, ...input.cc ?? [], ...input.bcc ?? []].map(value => value.address),
      rejected: [], submittedAt: new Date().toISOString() };
  }
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

  private async readMailbox<T>(account: EmailAccount, mailbox: string, read: (client: ImapFlow, generation: string, count: number) => Promise<T>): Promise<T> {
    const config = account.imap;
    const secret = resolveEmailSecret(config, this.env);
    const client = new ImapFlow({ host: config.host, port: config.port, secure: config.tls === "implicit", doSTARTTLS: config.tls === "starttls", logger: false,
      auth: { user: config.username, ...(config.auth.type === "oauth2" ? { accessToken: secret } : { pass: secret }) },
      connectionTimeout: account.connectionTimeoutMs, greetingTimeout: account.connectionTimeoutMs, socketTimeout: account.connectionTimeoutMs,
      tls: { rejectUnauthorized: true }, disableAutoIdle: true });
    client.on("error", () => {});
    try {
      return await this.bounded(account, () => client.close(), async () => {
        await client.connect();
        let opened;
        try { opened = await client.mailboxOpen(mailbox, { readOnly: true }); }
        catch (error) {
          if ((error as { responseStatus?: string }).responseStatus === "NO") throw new EmailError("EMAIL_INVALID_INPUT");
          throw error;
        }
        return read(client, String(opened.uidValidity), opened.exists);
      });
    } catch (error) { throw normalizedConnectionError(error); }
  }
  private async readMessage(client: ImapFlow, account: EmailAccount, mailbox: string, generation: string, id: number, uid: boolean): Promise<EmailMessage> {
    // BODY.PEEK[]<0.limit> bounds bytes at the provider before a source buffer is allocated.
    const result = await client.fetchOne(String(id), { uid: true, flags: true, internalDate: true, size: true, source: { start: 0, maxLength: EMAIL_SOURCE_LIMIT + 1 } }, { uid });
    if (!result) throw new EmailError("EMAIL_MESSAGE_NOT_FOUND");
    if ((result.size ?? 0) > EMAIL_SOURCE_LIMIT || !result.source || result.source.length > EMAIL_SOURCE_LIMIT) throw new EmailError("EMAIL_RESOURCE_LIMIT");
    return parseMessage(account, mailbox, generation, { uid: result.uid, source: result.source, flags: result.flags ?? new Set(), receivedAt: result.internalDate instanceof Date ? result.internalDate : new Date(0) });
  }
  private async nextSearchUid(client: ImapFlow, lower: number, upper: number, sort: MailQuery["sort"]): Promise<number | undefined> {
    if (lower > upper) return;
    let left = 1;
    let right = client.mailbox ? client.mailbox.exists : 0;
    let candidate: number | undefined;
    // Provider UIDs are monotone in sequence order. Binary lookup skips large UID gaps
    // without an unbounded SEARCH result or a scan of earlier pages.
    for (let probe = 0; left <= right; probe++) {
      if (probe >= 32) throw new EmailError("EMAIL_RESOURCE_LIMIT");
      const middle = Math.floor((left + right) / 2);
      const result = await client.fetchOne(String(middle), { uid: true });
      if (!result) throw new EmailError("EMAIL_CONNECTION_FAILED", true);
      if (sort === "oldest") {
        if (result.uid >= lower) { candidate = result.uid; right = middle - 1; }
        else left = middle + 1;
      } else {
        if (result.uid <= upper) { candidate = result.uid; left = middle + 1; }
        else right = middle - 1;
      }
    }
    if (candidate !== undefined && candidate >= lower && candidate <= upper) return candidate;
  }
  async search(input: SearchEmailsInput): Promise<SearchEmailsResult> {
    const account = this.accounts.get(input?.accountId);
    const query = searchQuery(input);
    const { mailbox } = query;
    return this.readMailbox(account, mailbox, async (client, generation) => {
      const cursor = decodeCursor(account, query, generation, input.cursor, this.cursorKey);
      const high = cursor?.high ?? (client.mailbox ? client.mailbox.uidNext - 1 : 0);
      const messages = [];
      let last = 0;
      let inspected = 0;
      let lower = query.sort === "oldest" && cursor ? cursor.last + 1 : 1;
      let upper = query.sort === "newest" && cursor ? cursor.last - 1 : high;
      while (lower <= upper) {
        const first = await this.nextSearchUid(client, lower, upper, query.sort);
        if (first === undefined) break;
        const windowLower = query.sort === "oldest" ? first : Math.max(lower, first - 99);
        const windowUpper = query.sort === "oldest" ? Math.min(upper, first + 99) : first;
        const found = await client.search({ uid: `${windowLower}:${windowUpper}` }, { uid: true });
        if (!Array.isArray(found) || found.length > 100 || new Set(found).size !== found.length || found.some(uid => !Number.isSafeInteger(uid) || uid < windowLower || uid > windowUpper)) throw new EmailError("EMAIL_RESOURCE_LIMIT");
        found.sort((a, b) => query.sort === "newest" ? b - a : a - b);
        for (const uid of found) {
          if (++inspected > account.searchWorkLimit) throw new EmailError("EMAIL_RESOURCE_LIMIT");
          const result = await client.fetchOne(String(uid), { uid: true, flags: true, internalDate: true, envelope: true }, { uid: true });
          if (!result) continue;
          const summary = envelopeSummary(account, mailbox, generation, result);
          if (!matchesSearch(summary, query)) continue;
          if (messages.length === query.limit) return { messages, nextCursor: searchCursor(account, query, generation, high, last, this.cursorKey) };
          messages.push(summary);
          last = result.uid;
        }
        if (query.sort === "oldest") lower = windowUpper + 1;
        else upper = windowLower - 1;
      }
      return { messages };
    });
  }
  async getMessage(ref: EmailMessageRef): Promise<EmailMessage> {
    const account = this.accounts.get(ref?.accountId);
    const decoded = decodeRef(account, ref);
    return this.readMailbox(account, decoded.mailbox, async (client, generation) => {
      if (generation !== decoded.generation) throw new EmailError("EMAIL_STALE_REFERENCE");
      return this.readMessage(client, account, decoded.mailbox, generation, decoded.uid, true);
    });
  }

  protected async submit(account: EmailAccount, input: SendEmailInput, operationId: string): Promise<SendEmailResult> {
    const config = account.smtp;
    const secret = resolveEmailSecret(config, this.env);
    let socket: Socket | undefined;
    const transport = nodemailer.createTransport({
      host: config.host, port: config.port, secure: config.tls === "implicit",
      requireTLS: config.tls === "starttls", ignoreTLS: config.tls === "none",
      connectionTimeout: account.connectionTimeoutMs, greetingTimeout: account.connectionTimeoutMs,
      socketTimeout: account.connectionTimeoutMs, logger: false, debug: false,
      tls: { rejectUnauthorized: true }, disableFileAccess: true, disableUrlAccess: true,
      getSocket: (_options: unknown, callback: (error: Error | null, result?: { connection: Socket; secured: boolean }) => void) => {
        let settled = false;
        const connected = (): void => { if (settled) return; settled = true; callback(null, { connection: socket!, secured: config.tls === "implicit" }); };
        socket = config.tls === "implicit"
          ? connectTls({ host: config.host, port: config.port, rejectUnauthorized: true, servername: config.host }, connected)
          : connectTcp({ host: config.host, port: config.port }, connected);
        socket.once("error", error => { if (!settled) { settled = true; callback(error); } });
      },
      auth: config.auth.type === "oauth2" ? { type: "OAuth2", user: config.username, accessToken: secret }
        : { user: config.username, pass: secret },
    } as SMTPTransport.Options);
    try {
      const receipt = await this.bounded(account, () => { socket?.destroy(); transport.close(); }, () => transport.sendMail({ from: input.from, to: input.to, cc: input.cc, bcc: input.bcc,
        subject: input.subject, text: input.text, html: input.html, inReplyTo: input.inReplyTo, references: input.references, messageId: `<${operationId}@stageflow>` }));
      return { operationId, messageId: receipt.messageId, accepted: receipt.accepted, rejected: receipt.rejected,
        submittedAt: new Date().toISOString() };
    } catch (error) {
      const fault = error as { code?: string; responseCode?: number; command?: string };
      if (fault.code === "EAUTH") throw new EmailError("EMAIL_AUTH_FAILED");
      if (fault.code === "EENVELOPE") throw new EmailError("EMAIL_RECIPIENTS_REJECTED");
      if (fault.responseCode && fault.responseCode >= 400) throw new EmailError("EMAIL_CONNECTION_FAILED", fault.responseCode < 500);
      if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(fault.code ?? "")) throw normalizedConnectionError(error);
      throw new EmailError("EMAIL_SEND_OUTCOME_UNKNOWN");
    } finally { socket?.destroy(); transport.close(); }
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

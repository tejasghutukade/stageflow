import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { simpleParser, type AddressObject } from "mailparser";
import type { FetchMessageObject, MessageAddressObject } from "imapflow";
import { EmailError, type EmailAddress, type EmailMessage, type EmailMessageRef, type EmailMessageSummary, type SearchEmailsInput } from "./port.js";
import type { EmailAccount } from "./accounts.js";
import { safeAttachmentFilename } from "./attachments.js";

export const EMAIL_SOURCE_LIMIT = 1024 * 1024;
const BODY_LIMIT = 128 * 1024;
export type MailRecord = { uid: number; source: Buffer; flags: Set<string>; receivedAt: Date };
type Reference = { scope: string; accountId: string; mailbox: string; generation: string; uid: number };
function scopeId(account: EmailAccount): string {
  return createHash("sha256").update(account.scope).digest("hex");
}
export function messageRef(account: EmailAccount, mailbox: string, generation: string, uid: number): EmailMessageRef {
  const value: Reference = { scope: scopeId(account), accountId: account.accountId, mailbox, generation, uid };
  return { accountId: account.accountId, mailbox, id: Buffer.from(JSON.stringify(value)).toString("base64url") };
}
export function decodeRef(account: EmailAccount, ref: EmailMessageRef): Reference {
  try {
    if (typeof ref.id !== "string" || ref.id.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(ref.id)) throw new Error();
    const value = JSON.parse(Buffer.from(ref.id, "base64url").toString()) as Reference;
    if (value.scope !== scopeId(account) || value.accountId !== account.accountId) throw new EmailError("EMAIL_UNAUTHORIZED");
    if (typeof value.generation !== "string" || !/^\d+$/.test(value.generation) || !Number.isSafeInteger(value.uid) || value.uid < 1) throw new Error();
    validateMailbox(value.mailbox);
    if (ref.mailbox !== undefined && ref.mailbox !== value.mailbox) throw new Error();
    return value;
  } catch (error) {
    if (error instanceof EmailError && error.code === "EMAIL_UNAUTHORIZED") throw error;
    throw new EmailError("EMAIL_INVALID_INPUT");
  }
}
export function validateMailbox(mailbox: string): void {
  if (typeof mailbox !== "string" || !mailbox.length || mailbox.length > 200 || /[\x00-\x1f\x7f]/.test(mailbox)) throw new EmailError("EMAIL_INVALID_INPUT");
}
export const EMAIL_SEARCH_FIELDS = ["from", "to", "subject", "unread", "flagged", "receivedAfter", "receivedBefore"];
export type MailQuery = { mailbox: string; limit: number; sort: "newest" | "oldest"; fingerprint: string; filters: SearchEmailsInput };
type Cursor = { query: string; scope: string; accountId: string; generation: string; high: number; last: number };
export function searchQuery(input: SearchEmailsInput): MailQuery {
  const mailbox = input.mailbox ?? "INBOX";
  validateMailbox(mailbox);
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new EmailError("EMAIL_INVALID_INPUT");
  if (input.sort !== undefined && !["newest", "oldest"].includes(input.sort)) throw new EmailError("EMAIL_INVALID_INPUT");
  for (const field of ["from", "to", "subject", "text"] as const) {
    if (input[field] !== undefined && (typeof input[field] !== "string" || !input[field]!.length || input[field]!.length > 4096 || /[\x00-\x1f\x7f]/.test(input[field]!))) throw new EmailError("EMAIL_INVALID_INPUT");
  }
  for (const field of ["unread", "flagged", "hasAttachments"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "boolean") throw new EmailError("EMAIL_INVALID_INPUT");
  }
  for (const field of ["receivedAfter", "receivedBefore"] as const) {
    const value = input[field];
    if (value !== undefined) {
      if (typeof value !== "string" || !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new EmailError("EMAIL_INVALID_INPUT");
      const calendar = new Date(`${value.slice(0, 10)}T00:00:00Z`);
      if (calendar.toISOString().slice(0, 10) !== value.slice(0, 10)) throw new EmailError("EMAIL_INVALID_INPUT");
    }
  }
  if (input.receivedAfter && input.receivedBefore && Date.parse(input.receivedAfter) >= Date.parse(input.receivedBefore)) throw new EmailError("EMAIL_INVALID_INPUT");
  const unsupported = ["text", "hasAttachments"].filter(field => (input as unknown as Record<string, unknown>)[field] !== undefined);
  if (unsupported.length) throw new EmailError("EMAIL_SEARCH_UNSUPPORTED", false, unsupported);
  const sort = input.sort ?? "newest";
  const filters: SearchEmailsInput = { accountId: input.accountId };
  for (const field of EMAIL_SEARCH_FIELDS) {
    const value = (input as unknown as Record<string, unknown>)[field];
    if (value !== undefined) (filters as unknown as Record<string, unknown>)[field] = value;
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({ mailbox, limit, sort, filters })).digest("hex");
  return { mailbox, limit, sort, fingerprint, filters };
}
export function matchesSearch(summary: EmailMessageSummary, query: MailQuery): boolean {
  const input = query.filters;
  if (input.from !== undefined && !summary.from.some(value => value.address.toLowerCase() === input.from!.toLowerCase())) return false;
  if (input.to !== undefined && !summary.to.some(value => value.address.toLowerCase() === input.to!.toLowerCase())) return false;
  if (input.subject !== undefined && !summary.subject?.toLowerCase().includes(input.subject.toLowerCase())) return false;
  if (input.unread !== undefined && summary.unread !== input.unread) return false;
  if (input.flagged !== undefined && summary.flagged !== input.flagged) return false;
  const received = Date.parse(summary.receivedAt);
  return !(input.receivedAfter && received < Date.parse(input.receivedAfter)) && !(input.receivedBefore && received >= Date.parse(input.receivedBefore));
}
export function searchCursor(account: EmailAccount, query: MailQuery, generation: string, high: number, last: number, key: Buffer): string {
  const value: Cursor = { query: query.fingerprint, scope: scopeId(account), accountId: account.accountId, generation, high, last };
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encoded}.${createHmac("sha256", key).update(encoded).digest("base64url")}`;
}
export function decodeCursor(account: EmailAccount, query: MailQuery, generation: string, cursor: string | undefined, key: Buffer): Cursor | undefined {
  if (cursor === undefined) return;
  try {
    if (typeof cursor !== "string" || cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const [encoded, signature] = cursor.split(".");
    const actual = Buffer.from(signature, "base64url");
    const expected = createHmac("sha256", key).update(encoded).digest();
    if (actual.toString("base64url") !== signature || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString()) as Cursor;
    if (value.accountId !== account.accountId || value.scope !== scopeId(account) || value.query !== query.fingerprint) throw new Error();
    if (!Number.isSafeInteger(value.high) || !Number.isSafeInteger(value.last) || value.last < 1 || value.last > value.high) throw new Error();
    if (value.generation !== generation) throw new EmailError("EMAIL_STALE_REFERENCE");
    return value;
  } catch (error) {
    if (error instanceof EmailError) throw error;
    throw new EmailError("EMAIL_INVALID_INPUT");
  }
}
function addresses(value: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  const objects = value ? (Array.isArray(value) ? value : [value]) : [];
  const result = objects.flatMap(object => object.value).filter(value => value.address).map(value => ({ address: value.address!.slice(0, 320), ...(value.name ? { name: value.name.slice(0, 200) } : {}) }));
  if (result.length > 100) throw new EmailError("EMAIL_RESOURCE_LIMIT");
  return result;
}
export async function parseMessage(account: EmailAccount, mailbox: string, generation: string, record: MailRecord): Promise<EmailMessage> {
  if (record.source.length > EMAIL_SOURCE_LIMIT) throw new EmailError("EMAIL_RESOURCE_LIMIT");
  let parsed;
  try {
    parsed = await simpleParser(record.source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: BODY_LIMIT });
  } catch { throw new EmailError("EMAIL_INVALID_INPUT"); }
  const text = parsed.text ?? "";
  const html = typeof parsed.html === "string" ? parsed.html : undefined;
  if (Buffer.byteLength(text) > BODY_LIMIT || (html !== undefined && Buffer.byteLength(html) > BODY_LIMIT) || parsed.attachments.length > 100) throw new EmailError("EMAIL_RESOURCE_LIMIT");
  const references = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : [];
  if (references.length > 100 || references.some(value => value.length > 998)) throw new EmailError("EMAIL_RESOURCE_LIMIT");
  return { ref: messageRef(account, mailbox, generation, record.uid),
    ...(parsed.messageId ? { messageId: parsed.messageId.slice(0, 998) } : {}),
    ...(parsed.inReplyTo ? { inReplyTo: parsed.inReplyTo.slice(0, 998) } : {}),
    from: addresses(parsed.from), to: addresses(parsed.to), cc: addresses(parsed.cc), replyTo: addresses(parsed.replyTo),
    ...(parsed.subject !== undefined ? { subject: parsed.subject.slice(0, 4096) } : {}),
    receivedAt: record.receivedAt.toISOString(), unread: !record.flags.has("\\Seen"), flagged: record.flags.has("\\Flagged"),
    hasAttachments: parsed.attachments.length > 0, preview: text.slice(0, 512), text, ...(html !== undefined ? { html } : {}), references,
    attachments: parsed.attachments.map((value, index) => ({ id: String(index), ...(value.filename ? { filename: safeAttachmentFilename(value.filename) } : {}), contentType: value.contentType.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200), size: value.size })) };
}
export function summarize(message: EmailMessage): EmailMessageSummary {
  const { cc: _cc, replyTo: _replyTo, text: _text, html: _html, inReplyTo: _inReplyTo, references: _references, attachments: _attachments, ...summary } = message;
  return summary;
}
export function envelopeSummary(account: EmailAccount, mailbox: string, generation: string, value: FetchMessageObject): EmailMessageSummary {
  function safeAddresses(values: MessageAddressObject[] = []): EmailAddress[] {
    if (values.length > 100) throw new EmailError("EMAIL_RESOURCE_LIMIT");
    return values.filter(value => value.address).map(value => ({ address: value.address!.slice(0, 320), ...(value.name ? { name: value.name.slice(0, 200) } : {}) }));
  }
  return { ref: messageRef(account, mailbox, generation, value.uid), from: safeAddresses(value.envelope?.from), to: safeAddresses(value.envelope?.to),
    ...(value.threadId ? { threadId: value.threadId.slice(0, 998) } : {}),
    ...(value.envelope?.messageId ? { messageId: value.envelope.messageId.slice(0, 998) } : {}),
    ...(value.envelope?.subject !== undefined ? { subject: value.envelope.subject.slice(0, 4096) } : {}),
    receivedAt: value.internalDate instanceof Date ? value.internalDate.toISOString() : new Date(0).toISOString(),
    unread: !value.flags?.has("\\Seen"), flagged: value.flags?.has("\\Flagged") ?? false };
}

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { attachmentReferencesSchema } from "./attachments.js";
import type { EmailAccount } from "./accounts.js";
import { EmailError, type SendEmailInput, type SendEmailResult, type EmailErrorCode } from "./port.js";

const address = z.object({ address: z.email(), name: z.string().max(200).regex(/^[^\r\n]*$/).optional() }).strict();
export const messageIdSchema = z.string().max(998).regex(/^[\x21-\x7e]+$/).regex(/^<[^<>\s@]+@[^<>\s@]+>$/);
const sendSchema = z.object({
  accountId: z.string().min(1), operationKey: z.string().min(1).max(200),
  from: z.email().optional(), to: z.array(address).max(100), cc: z.array(address).max(100).default([]),
  bcc: z.array(address).max(100).default([]), subject: z.string().max(998).regex(/^[^\r\n]*$/),
  text: z.string().max(262144), html: z.string().max(262144).optional(),
  inReplyTo: messageIdSchema.optional(), references: z.array(messageIdSchema).max(100).refine(values => values.join(" ").length <= 8192).optional(),
  attachments: attachmentReferencesSchema.optional(),
}).strict().refine(input => input.to.length + input.cc.length + input.bcc.length > 0);

export function validateSend(input: unknown, account: EmailAccount): SendEmailInput {
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) throw new EmailError("EMAIL_INVALID_INPUT");
  const from = parsed.data.from ?? account.address;
  if (![account.address, ...account.senderAliases].some(value => value.toLowerCase() === from.toLowerCase())) {
    throw new EmailError("EMAIL_UNAUTHORIZED");
  }
  return { ...parsed.data, from };
}

export type SubmissionRecord = {
  operationId: string; accountId: string; operationKey: string; hash: string;
  state: "pending" | "submitted" | "failed" | "unknown"; createdAt: string;
  receipt?: SendEmailResult; error?: { code: EmailErrorCode; retryable: boolean };
};

/** The host is the single writer. Pending records survive crashes as uncertain outcomes. */
export class EmailSubmissions {
  private readonly file: string;
  private records: SubmissionRecord[];
  private readonly active = new Map<string, Promise<SendEmailResult>>();
  constructor(scope: string) {
    this.file = path.join(scope, ".stageflow", "email-submissions.json");
    this.records = existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : [];
    for (const record of this.records) if (record.state === "pending") record.state = "unknown";
  }
  list(): SubmissionRecord[] { return structuredClone(this.records); }

  async send(input: SendEmailInput, submit: (operationId: string) => Promise<SendEmailResult>, identity?: unknown): Promise<SendEmailResult> {
    const hash = createHash("sha256").update(JSON.stringify(identity === undefined ? input : { input, identity })).digest("hex");
    const key = `${input.accountId}\0${input.operationKey}`;
    const found = this.records.find(record => record.accountId === input.accountId && record.operationKey === input.operationKey);
    if (found) {
      if (found.hash !== hash) throw new EmailError("EMAIL_OPERATION_CONFLICT");
      const active = this.active.get(key);
      if (active) return active;
      if (found.receipt) return structuredClone(found.receipt);
      if (found.state === "failed" && found.error) throw new EmailError(found.error.code, found.error.retryable);
      throw new EmailError("EMAIL_SEND_OUTCOME_UNKNOWN");
    }
    // Completed records expire after 30 days; unresolved records are never evicted.
    const cutoff = Date.now() - 30 * 86400000;
    this.records = this.records.filter(record => !["submitted", "failed"].includes(record.state) || Date.parse(record.createdAt) >= cutoff);
    if (this.records.length >= 10000) throw new EmailError("EMAIL_RESOURCE_LIMIT");
    const record: SubmissionRecord = { operationId: randomUUID(), accountId: input.accountId,
      operationKey: input.operationKey, hash, state: "pending", createdAt: new Date().toISOString() };
    this.records.push(record);
    this.persist();
    const work = Promise.resolve().then(() => submit(record.operationId)).then(receipt => {
      record.state = "submitted";
      record.receipt = receipt;
      this.persist();
      return structuredClone(receipt);
    }).catch(error => {
      const fault = error instanceof EmailError ? error : new EmailError("EMAIL_SEND_OUTCOME_UNKNOWN");
      record.state = fault.code === "EMAIL_SEND_OUTCOME_UNKNOWN" ? "unknown" : "failed";
      record.error = { code: fault.code, retryable: fault.retryable };
      delete record.receipt;
      try {
        this.persist();
      } catch {
        // The previously durable pending record is sufficient to forbid resubmission.
        record.state = "unknown";
        throw new EmailError("EMAIL_SEND_OUTCOME_UNKNOWN");
      }
      throw fault;
    }).finally(() => { this.active.delete(key); });
    this.active.set(key, work);
    return work;
  }
  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.records), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}

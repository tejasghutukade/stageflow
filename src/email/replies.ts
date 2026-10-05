import { z } from "zod";
import type { EmailAccount } from "./accounts.js";
import { EmailError, type EmailAddress, type EmailMessage, type ReplyToEmailInput, type SendEmailInput } from "./port.js";
import { messageIdSchema } from "./submissions.js";
import { attachmentReferencesSchema } from "./attachments.js";

const replySchema = z.object({
  ref: z.object({ accountId: z.string().min(1), id: z.string().min(1).max(2048), mailbox: z.string().max(200).optional() }).strict(),
  operationKey: z.string().min(1).max(200), from: z.email().optional(),
  text: z.string().max(262144), html: z.string().max(262144).optional(), replyAll: z.boolean().default(false),
  attachments: attachmentReferencesSchema.optional(),
}).strict();

export function validateReply(input: unknown): ReplyToEmailInput {
  const parsed = replySchema.safeParse(input);
  if (!parsed.success) throw new EmailError("EMAIL_INVALID_INPUT");
  return parsed.data;
}

/** Only normalized source data can supply recipients and conversation headers. */
export function replyMessage(account: EmailAccount, original: EmailMessage, input: ReplyToEmailInput): SendEmailInput {
  function usable(values: EmailAddress[]): EmailAddress[] {
    return values.filter(value => z.email().safeParse(value.address).success).map(value => ({
      address: value.address,
      ...(value.name ? { name: value.name.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 200) } : {}),
    }));
  }
  const replyTo = usable(original.replyTo);
  const sender = replyTo.length ? replyTo : usable(original.from);
  const seen = new Set([account.address, ...account.senderAliases].map(value => value.toLowerCase()));
  function unique(values: EmailAddress[]): EmailAddress[] {
    return values.filter(value => {
      const key = value.address.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const to = unique(input.replyAll ? [...sender, ...usable(original.to)] : sender);
  const cc = input.replyAll ? unique(usable(original.cc)) : [];
  if (!to.length && !cc.length) throw new EmailError("EMAIL_INVALID_INPUT");
  const messageId = messageIdSchema.safeParse(original.messageId).success ? original.messageId : undefined;
  const priorId = messageIdSchema.safeParse(original.inReplyTo).success ? original.inReplyTo : undefined;
  const references = [...new Set(original.references.filter(value => messageIdSchema.safeParse(value).success))];
  if (!references.length && priorId) references.push(priorId);
  if (messageId && !references.includes(messageId)) references.push(messageId);
  if (references.length > 100 || references.join(" ").length > 8192) throw new EmailError("EMAIL_RESOURCE_LIMIT");
  const subject = (original.subject ?? "").replace(/[\x00-\x1f\x7f]/g, " ").replace(/^(?:\s*re\s*:\s*)+/i, "").trim().slice(0, 994);
  return { accountId: account.accountId, operationKey: input.operationKey, from: input.from, to, cc,
    subject: subject ? `Re: ${subject}` : "Re:", text: input.text, html: input.html, attachments: input.attachments,
    ...(messageId ? { inReplyTo: messageId } : {}), ...(references.length ? { references } : {}) };
}

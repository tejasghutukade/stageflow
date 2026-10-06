export type EmailErrorCode =
  | "EMAIL_INVALID_INPUT" | "EMAIL_ACCOUNT_NOT_FOUND" | "EMAIL_ACCOUNT_DISABLED"
  | "EMAIL_UNAUTHORIZED" | "EMAIL_AUTH_FAILED" | "EMAIL_TOKEN_EXPIRED"
  | "EMAIL_CONNECTION_FAILED" | "EMAIL_TIMEOUT" | "EMAIL_RATE_LIMIT"
  | "EMAIL_MESSAGE_NOT_FOUND" | "EMAIL_STALE_REFERENCE" | "EMAIL_UNSUPPORTED"
  | "EMAIL_SEARCH_UNSUPPORTED" | "EMAIL_RESOURCE_LIMIT" | "EMAIL_SEND_OUTCOME_UNKNOWN"
  | "EMAIL_OPERATION_CONFLICT" | "EMAIL_RECIPIENTS_REJECTED" | "EMAIL_EVENT_ACCEPTANCE_FAILED" | "EMAIL_STORAGE_FAILED"
  | "EMAIL_TRIGGER_TARGET_INVALID";

export class EmailError extends Error {
  constructor(public readonly code: EmailErrorCode, public readonly retryable = false, public readonly unsupportedFields?: string[]) {
    super(code);
    this.name = "EmailError";
  }
}

export type EmailAddress = { address: string; name?: string };
export type EmailMessageRef = { accountId: string; id: string; mailbox?: string };
export type EmailAttachment = { id: string; filename?: string; contentType: string; size: number };
/** Host authority. Never deserialize this value from a worker request. */
export type EmailArtifactContext = { workspaceDir: string; stageId: string; attempt: number };
export type DownloadEmailAttachmentInput = { ref: EmailMessageRef; attachmentId: string };
export type DownloadEmailAttachmentResult = EmailAttachment & { artifact: string };
export type PreparedEmailAttachment = { filename: string; content: Buffer };
export type EmailMessageSummary = {
  ref: EmailMessageRef; messageId?: string; threadId?: string;
  from: EmailAddress[]; to: EmailAddress[]; subject?: string; receivedAt: string;
  unread: boolean; flagged: boolean; hasAttachments?: boolean; preview?: string;
};
export type EmailMessage = EmailMessageSummary & {
  cc: EmailAddress[]; replyTo: EmailAddress[]; text: string; html?: string;
  inReplyTo?: string; references: string[]; attachments: EmailAttachment[];
};
export type SendEmailInput = {
  accountId: string; operationKey: string; from?: string; to: EmailAddress[];
  cc?: EmailAddress[]; bcc?: EmailAddress[]; subject: string; text: string; html?: string;
  inReplyTo?: string; references?: string[]; attachments?: { artifact: string; filename?: string }[];
};
export type ReplyToEmailInput = {
  ref: EmailMessageRef; operationKey: string; from?: string; text: string; html?: string; replyAll?: boolean;
  attachments?: SendEmailInput["attachments"];
};
export type SendEmailResult = {
  operationId: string; messageId?: string; accepted: string[]; rejected: string[];
  submittedAt: string; warnings?: string[];
};
export type SearchEmailsInput = {
  accountId: string; mailbox?: string; text?: string; from?: string; to?: string;
  subject?: string; unread?: boolean; flagged?: boolean; hasAttachments?: boolean;
  receivedAfter?: string; receivedBefore?: string; limit?: number; cursor?: string;
  sort?: "newest" | "oldest";
};
export type SearchEmailsResult = { messages: EmailMessageSummary[]; nextCursor?: string };
export type EmailConnectionStatus = {
  state: "ok" | "failed"; error?: { code: EmailErrorCode; retryable: boolean };
};
export type EmailAccountStatus = {
  accountId: string; checkedAt: string; imap?: EmailConnectionStatus; smtp?: EmailConnectionStatus;
  capabilities: { operations: string[]; searchFields: string[]; idle: boolean };
};
export type EmailReceivedEvent = {
  type: "email.received"; version: 1; eventId: string; accountId: string;
  message: EmailMessageSummary; receivedAt: string; detectedAt: string;
};
export interface EmailMailbox {
  /** Host-only historical event retrieval. Validates current provider identity without changing watcher progress. */
  getReceivedEvent?(ref: EmailMessageRef): Promise<EmailReceivedEvent>;
  testAccount(accountId: string, protocol?: "imap" | "smtp" | "both"): Promise<EmailAccountStatus>;
  send(input: SendEmailInput, context?: EmailArtifactContext): Promise<SendEmailResult>;
  reply(input: ReplyToEmailInput, context?: EmailArtifactContext): Promise<SendEmailResult>;
  downloadAttachment(input: DownloadEmailAttachmentInput, context?: EmailArtifactContext): Promise<DownloadEmailAttachmentResult>;
  getMessage(ref: EmailMessageRef): Promise<EmailMessage>;
  search(input: SearchEmailsInput): Promise<SearchEmailsResult>;
}
export interface EmailEventSource {
  start(emit: (event: EmailReceivedEvent) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}

import { SimpleTextAttachmentAdapter, type AttachmentAdapter, type CompleteAttachment, type PendingAttachment } from "@assistant-ui/react";
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENT_BYTES,
  looksLikeTextFile,
} from "../workshop/chat/attachments";

function rejected(file: File, message: string): PendingAttachment {
  return {
    id: crypto.randomUUID(),
    type: "document",
    name: file.name,
    contentType: file.type || "text/plain",
    file,
    status: { type: "incomplete", reason: "error", message },
  };
}

/** Text files only, with the same size rule as Workshop chat. */
export class GuideTextAttachmentAdapter implements AttachmentAdapter {
  readonly accept = ATTACHMENT_ACCEPT;
  private readonly inner = new SimpleTextAttachmentAdapter();

  async add(state: { file: File }): Promise<PendingAttachment> {
    const file = state.file;
    if (!looksLikeTextFile(file)) return rejected(file, `${file.name} is not a text file`);
    if (file.size > MAX_ATTACHMENT_BYTES) return rejected(file, `${file.name} is over 256 KB`);
    return this.inner.add(state);
  }

  async send(attachment: PendingAttachment, options?: { signal?: AbortSignal }): Promise<CompleteAttachment> {
    if (attachment.status.type === "incomplete") {
      throw new Error(attachment.status.message ?? "attachment");
    }
    return this.inner.send(attachment, options);
  }

  async remove(): Promise<void> {}
}

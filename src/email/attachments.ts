import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { simpleParser } from "mailparser";
import { z } from "zod";
import { isInsideDir, resolveArtifactTarget } from "../runstore/workspaceLayout.js";
import type { EmailAccount } from "./accounts.js";
import { EmailError, type EmailArtifactContext, type SendEmailInput, type PreparedEmailAttachment, type DownloadEmailAttachmentResult } from "./port.js";

export const attachmentReferencesSchema = z.array(z.object({ artifact: z.string().min(1).max(2048), filename: z.string().max(200).optional() }).strict()).max(100);
export const attachmentLimitsSchema = z.object({
  count: z.number().int().min(1).max(100).default(10),
  perFileBytes: z.number().int().min(1).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
  totalBytes: z.number().int().min(1).max(32 * 1024 * 1024).default(5 * 1024 * 1024),
  downloadBytes: z.number().int().min(1).max(32 * 1024 * 1024).default(8 * 1024 * 1024),
}).strict();

export function safeAttachmentFilename(filename: string | undefined): string {
  const name = (filename ?? "attachment").split(/[/\\]/).at(-1)!.replace(/[\x00-\x1f\x7f]/g, "_").replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 200).trim();
  return !name || name === "." || name === ".." ? "attachment" : name;
}

/** Reject symlinks in every descendant, including artifact directories. */
async function containedPath(context: EmailArtifactContext, relative: string, createDirectories = false): Promise<string> {
  if (typeof relative !== "string" || relative.includes("\\") || path.isAbsolute(relative) || relative.split("/").some(segment => !segment || segment === "." || segment === ".." || segment === ".pi-agent" || segment === "auth.json" || segment === "pi-session.jsonl")) throw new EmailError("EMAIL_UNAUTHORIZED");
  const root = await realpath(context.workspaceDir);
  const segments = relative.split("/");
  let current = root;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    const last = index === segments.length - 1;
    if (createDirectories && !last) await mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
    if (createDirectories && last) break;
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (!last && !stat.isDirectory()) || (last && (!stat.isFile() || stat.nlink !== 1))) throw new EmailError("EMAIL_UNAUTHORIZED");
    const resolved = await realpath(current);
    if (!isInsideDir(resolved, root)) throw new EmailError("EMAIL_UNAUTHORIZED");
  }
  return current;
}

export async function prepareAttachments(account: EmailAccount, references: SendEmailInput["attachments"], context?: EmailArtifactContext): Promise<PreparedEmailAttachment[]> {
  if (!references?.length) return [];
  if (!context) throw new EmailError("EMAIL_UNAUTHORIZED");
  if (references.length > account.attachmentLimits.count) throw new EmailError("EMAIL_RESOURCE_LIMIT");
  let total = 0;
  const attachments: PreparedEmailAttachment[] = [];
  for (const reference of references) {
    // Only run artifact files are eligible; arbitrary run files are not.
    if (!/^stages\/[^/]+\/(?:attempts\/[1-9]\d*\/)?artifacts\/.+/.test(reference.artifact)) throw new EmailError("EMAIL_UNAUTHORIZED");
    let handle;
    try {
      const target = await containedPath(context, reference.artifact);
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new EmailError("EMAIL_UNAUTHORIZED");
      await containedPath(context, reference.artifact);
      const checked = await lstat(target);
      if (checked.dev !== stat.dev || checked.ino !== stat.ino || !checked.isFile() || checked.nlink !== 1) throw new EmailError("EMAIL_UNAUTHORIZED");
      const limit = Math.min(account.attachmentLimits.perFileBytes, account.attachmentLimits.totalBytes - total);
      if (stat.size > limit) throw new EmailError("EMAIL_RESOURCE_LIMIT");
      // Read from this descriptor once. Hash and SMTP use these same bounded bytes.
      const content = Buffer.alloc(limit + 1);
      let size = 0;
      while (size <= limit) {
        const read = await handle.read(content, size, Math.min(65536, content.length - size), null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > limit) throw new EmailError("EMAIL_RESOURCE_LIMIT");
      total += size;
      attachments.push({ filename: safeAttachmentFilename(reference.filename ?? path.basename(reference.artifact)), content: Buffer.from(content.subarray(0, size)) });
    } catch (error) {
      if (error instanceof EmailError) throw error;
      throw new EmailError("EMAIL_UNAUTHORIZED");
    } finally { await handle?.close(); }
  }
  return attachments;
}

export function attachmentIdentity(attachments: PreparedEmailAttachment[]): { filename: string; size: number; sha256: string }[] {
  return attachments.map(value => ({ filename: value.filename, size: value.content.length, sha256: createHash("sha256").update(value.content).digest("hex") }));
}

export async function saveSelectedAttachment(account: EmailAccount, source: Buffer, attachmentId: string, context: EmailArtifactContext, validateAccount: () => void): Promise<DownloadEmailAttachmentResult> {
  if (source.length > account.attachmentLimits.downloadBytes) throw new EmailError("EMAIL_RESOURCE_LIMIT");
  if (typeof attachmentId !== "string" || !/^(0|[1-9]\d{0,2})$/.test(attachmentId)) throw new EmailError("EMAIL_INVALID_INPUT");
  let parsed;
  try { parsed = await simpleParser(source, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: 128 * 1024 }); }
  catch { throw new EmailError("EMAIL_INVALID_INPUT"); }
  if (parsed.attachments.length > account.attachmentLimits.count) throw new EmailError("EMAIL_RESOURCE_LIMIT");
  const selected = parsed.attachments[Number(attachmentId)];
  if (!selected) throw new EmailError("EMAIL_MESSAGE_NOT_FOUND");
  if (selected.size > account.attachmentLimits.perFileBytes || selected.content.length > account.attachmentLimits.perFileBytes || selected.content.length > account.attachmentLimits.totalBytes) throw new EmailError("EMAIL_RESOURCE_LIMIT");
  const filename = safeAttachmentFilename(selected.filename);
  const artifact = resolveArtifactTarget(context.workspaceDir, context.stageId, context.attempt, `email-${randomUUID()}.bin`).runRelativePath;
  let target: string | undefined;
  let created = false;
  try {
    validateAccount();
    target = await containedPath(context, artifact, true);
    validateAccount();
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    try { await handle.writeFile(selected.content); } finally { await handle.close(); }
    // Recheck directory containment after the write; never return an escaped result.
    await containedPath(context, artifact);
    validateAccount();
    return { id: attachmentId, filename, contentType: selected.contentType.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200), size: selected.content.length, artifact };
  } catch (error) {
    if (created && target) await unlink(target).catch(() => {});
    if (error instanceof EmailError) throw error;
    throw new EmailError("EMAIL_UNAUTHORIZED");
  }
}

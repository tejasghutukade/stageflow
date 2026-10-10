import type { WorkshopChatAttachment } from "../../../api";

export type { WorkshopChatAttachment };

export type WorkshopAttachmentMeta = {
  name: string;
  size: number;
  mediaType: string;
};

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 256 * 1024;

export const ATTACHMENT_ACCEPT =
  ".txt,.md,.markdown,.yaml,.yml,.json,.jsonl,.csv,.tsv,.xml,.html,.css,.js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.rb,.go,.rs,.java,.kt,.swift,.sh,.toml,.ini,.env,.log,.sql,.diff,.patch,text/*";

const TEXT_EXTENSIONS = new Set(
  ATTACHMENT_ACCEPT.split(",")
    .filter((entry) => entry.startsWith("."))
    .map((entry) => entry.slice(1)),
);

const TEXT_MEDIA_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/sql",
]);

export type AttachmentCandidate = { name: string; size: number; type: string };

export function looksLikeTextFile(file: AttachmentCandidate): boolean {
  if (file.type.startsWith("text/")) return true;
  if (TEXT_MEDIA_TYPES.has(file.type)) return true;
  const dot = file.name.lastIndexOf(".");
  if (dot < 0) return file.type === "";
  return TEXT_EXTENSIONS.has(file.name.slice(dot + 1).toLowerCase());
}

export function mediaTypeFor(file: AttachmentCandidate): string {
  return file.type || "text/plain";
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 102.4) / 10} KB`;
  return `${Math.round(size / (1024 * 102.4)) / 10} MB`;
}

export type AttachmentPlan<T extends AttachmentCandidate> = {
  accepted: T[];
  errors: string[];
};

export function planAttachmentAdds<T extends AttachmentCandidate>(
  existing: readonly { name: string }[],
  candidates: readonly T[],
): AttachmentPlan<T> {
  const accepted: T[] = [];
  const errors: string[] = [];
  const names = new Set(existing.map((item) => item.name));
  let room = MAX_ATTACHMENTS - existing.length;
  let overflow = 0;
  for (const file of candidates) {
    if (!looksLikeTextFile(file)) {
      errors.push(`${file.name} is not a text file`);
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      errors.push(`${file.name} is over 256 KB`);
      continue;
    }
    if (names.has(file.name)) continue;
    if (room <= 0) {
      overflow += 1;
      continue;
    }
    accepted.push(file);
    names.add(file.name);
    room -= 1;
  }
  if (overflow > 0) errors.push(`Up to ${MAX_ATTACHMENTS} files per message`);
  return { accepted, errors };
}

export function textContentLooksBinary(content: string): boolean {
  return content.includes("\u0000");
}

export function attachmentMetaList(value: unknown): WorkshopAttachmentMeta[] {
  if (!Array.isArray(value)) return [];
  const out: WorkshopAttachmentMeta[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name) continue;
    out.push({
      name: record.name,
      size: typeof record.size === "number" ? record.size : 0,
      mediaType:
        typeof record.mediaType === "string" ? record.mediaType : "text/plain",
    });
  }
  return out;
}

export function userMessageCustom(
  attachments: readonly WorkshopChatAttachment[],
  docs: boolean,
): Record<string, unknown> {
  return {
    ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
    ...(docs ? { context: { docs: true } } : {}),
  };
}

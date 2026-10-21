import { readFile } from "node:fs/promises";
import path from "node:path";
import { resolveWorkshopCatalogRoot } from "../operatorAgent/docsRetrieval.js";

export const WORKSHOP_CHAT_ATTACHMENT_MAX_FILES = 5;
export const WORKSHOP_CHAT_ATTACHMENT_MAX_BYTES = 256 * 1024;
export const WORKSHOP_DOCS_REFERENCE_PATHS = [
  "docs/yaml-catalog.md",
  "skills/stageflow-author/references/catalog-mapping.md",
] as const;

export type WorkshopDocsReference = { path: string; text: string };

export type WorkshopChatAttachment = {
  name: string;
  mediaType: string;
  size: number;
  content: string;
};

export type WorkshopChatContext = { docs?: boolean };

export type ParseWorkshopChatAttachmentsResult =
  | { ok: true; attachments: WorkshopChatAttachment[] }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseWorkshopChatAttachments(
  value: unknown,
): ParseWorkshopChatAttachmentsResult {
  if (value === undefined || value === null) {
    return { ok: true, attachments: [] };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: "attachments must be an array" };
  }
  if (value.length > WORKSHOP_CHAT_ATTACHMENT_MAX_FILES) {
    return {
      ok: false,
      error: `At most ${WORKSHOP_CHAT_ATTACHMENT_MAX_FILES} attachments per message`,
    };
  }
  const attachments: WorkshopChatAttachment[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry)) {
      return { ok: false, error: `attachments[${index}] must be an object` };
    }
    const name =
      typeof entry.name === "string" ? entry.name.replace(/\s+/g, " ").trim() : "";
    if (!name) {
      return { ok: false, error: `attachments[${index}].name is required` };
    }
    if (typeof entry.content !== "string") {
      return {
        ok: false,
        error: `attachments[${index}].content must be a string (${name})`,
      };
    }
    if (entry.mediaType !== undefined && typeof entry.mediaType !== "string") {
      return {
        ok: false,
        error: `attachments[${index}].mediaType must be a string (${name})`,
      };
    }
    const size = Buffer.byteLength(entry.content, "utf8");
    if (size > WORKSHOP_CHAT_ATTACHMENT_MAX_BYTES) {
      return {
        ok: false,
        error: `Attachment ${name} exceeds ${WORKSHOP_CHAT_ATTACHMENT_MAX_BYTES / 1024} KB`,
      };
    }
    attachments.push({
      name,
      mediaType: entry.mediaType?.trim() || "text/plain",
      size,
      content: entry.content,
    });
  }
  return { ok: true, attachments };
}

export function parseWorkshopChatContext(value: unknown): WorkshopChatContext {
  return isPlainObject(value) && value.docs === true ? { docs: true } : {};
}

function fenceFor(content: string): string {
  const longest = (content.match(/`+/g) ?? []).reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  return "`".repeat(Math.max(3, longest + 1));
}

function fencedBlock(heading: string, content: string): string {
  const fence = fenceFor(content);
  const body = content.endsWith("\n") ? content : `${content}\n`;
  return `${heading}\n${fence}\n${body}${fence}`;
}

export async function readWorkshopDocsReference(
  rootDir?: string,
): Promise<WorkshopDocsReference | null> {
  const root = resolveWorkshopCatalogRoot(rootDir);
  for (const relPath of WORKSHOP_DOCS_REFERENCE_PATHS) {
    try {
      const text = await readFile(path.join(root, relPath), "utf8");
      if (text.trim()) return { path: relPath, text };
    } catch {
      continue;
    }
  }
  return null;
}

export function buildWorkshopChatPrompt(
  message: string,
  attachments: readonly WorkshopChatAttachment[],
  docsReference: WorkshopDocsReference | null,
): string {
  const sections = [message];
  for (const attachment of attachments) {
    sections.push(
      fencedBlock(`Attached file: ${attachment.name}`, attachment.content),
    );
  }
  if (docsReference) {
    sections.push(
      fencedBlock(
        `Stageflow YAML authoring reference (${docsReference.path}):`,
        docsReference.text,
      ),
    );
  }
  return sections.join("\n\n");
}

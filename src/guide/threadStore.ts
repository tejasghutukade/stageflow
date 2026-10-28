import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";

export type GuideAttachmentMeta = {
  name: string;
  size: number;
  mediaType: string;
};

export type GuidePart =
  | { type: "text"; text: string }
  | {
      type: "tool";
      id: string;
      name: string;
      status: "complete" | "error";
      args?: Record<string, unknown>;
      result?: unknown;
      error?: string;
    };

export type GuideMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  attachments?: GuideAttachmentMeta[];
  parts?: GuidePart[];
};

export type GuideThreadRecord = {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: GuideMessage[];
  model?: string;
};

export type GuideThreadSummary = {
  id: string;
  title: string;
  updatedAt: string;
};

function guardThreadId(threadId: string): string {
  const trimmed = threadId.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..") || trimmed === ".") {
    throw new Error("guide.invalid");
  }
  return trimmed;
}

export function guideThreadsDir(storeRoot = globalStageflowHome()): string {
  return path.join(storeRoot, "guide", "threads");
}

export function guideThreadFilePath(threadId: string, storeRoot = globalStageflowHome()): string {
  return path.join(guideThreadsDir(storeRoot), guardThreadId(threadId), "thread.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseMessage(value: unknown): GuideMessage | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (value.role !== "user" && value.role !== "assistant") return null;
  if (typeof value.text !== "string") return null;
  if (typeof value.createdAt !== "string" || !value.createdAt) return null;
  const attachments = attachmentMeta(value.attachments);
  const parts = guideParts(value.parts);
  return {
    id: value.id,
    role: value.role,
    text: value.text,
    createdAt: value.createdAt,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(parts.length > 0 ? { parts } : {}),
  };
}

function guideParts(value: unknown): GuidePart[] {
  if (!Array.isArray(value)) return [];
  const out: GuidePart[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    if (entry.type === "text" && typeof entry.text === "string") {
      out.push({ type: "text", text: entry.text });
      continue;
    }
    if (entry.type !== "tool" || typeof entry.id !== "string" || typeof entry.name !== "string") continue;
    if (entry.status !== "complete" && entry.status !== "error") continue;
    out.push({
      type: "tool",
      id: entry.id,
      name: entry.name,
      status: entry.status,
      ...(isPlainObject(entry.args) ? { args: entry.args } : {}),
      ...(entry.result !== undefined ? { result: entry.result } : {}),
      ...(typeof entry.error === "string" ? { error: entry.error } : {}),
    });
  }
  return out;
}

function attachmentMeta(value: unknown): GuideAttachmentMeta[] {
  if (!Array.isArray(value)) return [];
  const out: GuideAttachmentMeta[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry) || typeof entry.name !== "string" || !entry.name) continue;
    out.push({
      name: entry.name,
      size: typeof entry.size === "number" ? entry.size : 0,
      mediaType: typeof entry.mediaType === "string" && entry.mediaType ? entry.mediaType : "text/plain",
    });
  }
  return out;
}

export function parseGuideThread(value: unknown): GuideThreadRecord | null {
  if (!isPlainObject(value) || value.version !== 1) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (typeof value.title !== "string") return null;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return null;
  if (!Array.isArray(value.messages)) return null;
  const messages: GuideMessage[] = [];
  for (const entry of value.messages) {
    const message = parseMessage(entry);
    if (!message) return null;
    messages.push(message);
  }
  const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined;
  return {
    version: 1,
    id: value.id,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    messages,
    ...(model ? { model } : {}),
  };
}

function writeRecord(record: GuideThreadRecord, storeRoot?: string): void {
  const file = guideThreadFilePath(record.id, storeRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record));
}

export function createGuideThread(storeRoot?: string): GuideThreadRecord {
  const now = new Date().toISOString();
  const record: GuideThreadRecord = {
    version: 1,
    id: randomUUID(),
    title: "",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  writeRecord(record, storeRoot);
  return record;
}

export function readGuideThread(threadId: string, storeRoot?: string): GuideThreadRecord | null {
  let file: string;
  try {
    file = guideThreadFilePath(threadId, storeRoot);
  } catch {
    return null;
  }
  if (!existsSync(file)) return null;
  try {
    return parseGuideThread(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export function saveGuideThread(record: GuideThreadRecord, storeRoot?: string): GuideThreadRecord {
  writeRecord(record, storeRoot);
  return record;
}

export function setGuideThreadModel(
  threadId: string,
  model: string | null,
  storeRoot?: string,
): GuideThreadRecord | null {
  const record = readGuideThread(threadId, storeRoot);
  if (!record) return null;
  const trimmed = typeof model === "string" ? model.trim() : "";
  const next: GuideThreadRecord = {
    version: 1,
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: new Date().toISOString(),
    messages: record.messages,
    ...(trimmed ? { model: trimmed } : {}),
  };
  writeRecord(next, storeRoot);
  return next;
}

export function listGuideThreads(storeRoot?: string): GuideThreadSummary[] {
  const dir = guideThreadsDir(storeRoot);
  if (!existsSync(dir)) return [];
  const summaries: GuideThreadSummary[] = [];
  for (const entry of readdirSync(dir)) {
    const record = readGuideThread(entry, storeRoot);
    if (!record) continue;
    summaries.push({ id: record.id, title: record.title, updatedAt: record.updatedAt });
  }
  summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return summaries;
}

export function guideTitleFrom(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "New chat";
  return flat.length > 48 ? `${flat.slice(0, 47).trimEnd()}…` : flat;
}

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";
import type { SummaryLine } from "./definitionSummary.js";
import type { AgentAuthorDraft } from "../operatorAgent/index.js";

export type AuthorSessionMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  summaryLines?: SummaryLine[];
};

export type AuthorSessionRecord = {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  draft: AgentAuthorDraft;
  transcript: AuthorSessionMessage[];
  model?: string;
};

function guardSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..") || trimmed === ".") {
    throw new Error("agent.invalid");
  }
  return trimmed;
}

export function authorSessionsDir(storeRoot = globalStageflowHome()): string {
  return path.join(storeRoot, "agents", "author-sessions");
}

export function authorSessionFilePath(sessionId: string, storeRoot = globalStageflowHome()): string {
  return path.join(authorSessionsDir(storeRoot), guardSessionId(sessionId), "session.json");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseMessage(value: unknown): AuthorSessionMessage | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (value.role !== "user" && value.role !== "assistant") return null;
  if (typeof value.text !== "string") return null;
  if (typeof value.createdAt !== "string" || !value.createdAt) return null;
  const summaryLines = Array.isArray(value.summaryLines)
    ? value.summaryLines.flatMap((line) => {
        if (!isPlainObject(line) || typeof line.label !== "string" || typeof line.value !== "string") return [];
        return [{ label: line.label, value: line.value }];
      })
    : [];
  return {
    id: value.id,
    role: value.role,
    text: value.text,
    createdAt: value.createdAt,
    ...(summaryLines.length > 0 ? { summaryLines } : {}),
  };
}

export function parseAuthorSession(value: unknown): AuthorSessionRecord | null {
  if (!isPlainObject(value) || value.version !== 1) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return null;
  if (!isPlainObject(value.draft)) return null;
  if (!Array.isArray(value.transcript)) return null;
  const transcript: AuthorSessionMessage[] = [];
  for (const entry of value.transcript) {
    const message = parseMessage(entry);
    if (!message) return null;
    transcript.push(message);
  }
  const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined;
  return {
    version: 1,
    id: value.id,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    draft: value.draft,
    transcript,
    ...(model ? { model } : {}),
  };
}

function writeRecord(record: AuthorSessionRecord, storeRoot?: string): void {
  const file = authorSessionFilePath(record.id, storeRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record));
}

export function createAuthorSession(input: { draft?: AgentAuthorDraft; model?: string } = {}, storeRoot?: string): AuthorSessionRecord {
  const now = new Date().toISOString();
  const record: AuthorSessionRecord = {
    version: 1,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    draft: { ...(input.draft ?? {}) },
    transcript: [],
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
  };
  writeRecord(record, storeRoot);
  return record;
}

export function readAuthorSession(sessionId: string, storeRoot?: string): AuthorSessionRecord | null {
  let file: string;
  try {
    file = authorSessionFilePath(sessionId, storeRoot);
  } catch {
    return null;
  }
  if (!existsSync(file)) return null;
  try {
    return parseAuthorSession(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch {
    return null;
  }
}

export function saveAuthorSession(record: AuthorSessionRecord, storeRoot?: string): AuthorSessionRecord {
  const next = { ...record, updatedAt: new Date().toISOString() };
  writeRecord(next, storeRoot);
  return next;
}

export type AuthorDraftSummary = {
  id: string;
  name: string;
  updatedAt: string;
  messages: number;
};

function draftTitle(draft: AgentAuthorDraft): string {
  const name = typeof draft.name === "string" ? draft.name.trim() : "";
  return name || "Untitled draft";
}

function draftHasWork(record: AuthorSessionRecord): boolean {
  if (record.transcript.length > 0) return true;
  for (const key of ["name", "instructions", "description"] as const) {
    const value = record.draft[key];
    if (typeof value === "string" && value.trim()) return true;
  }
  return false;
}

/** Unsaved author sessions, newest first. Empty shells with no name and no chat are left out. */
export function listAuthorDrafts(storeRoot = globalStageflowHome()): AuthorDraftSummary[] {
  const dir = authorSessionsDir(storeRoot);
  if (!existsSync(dir)) return [];
  const drafts: AuthorDraftSummary[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const record = readAuthorSession(entry.name, storeRoot);
    if (!record || !draftHasWork(record)) continue;
    drafts.push({
      id: record.id,
      name: draftTitle(record.draft),
      updatedAt: record.updatedAt,
      messages: record.transcript.length,
    });
  }
  drafts.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return drafts;
}

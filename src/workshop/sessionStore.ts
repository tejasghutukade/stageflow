import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";

export const WORKSHOP_SESSION_TITLE_MAX_LENGTH = 80;

export type WorkshopSessionMessageRole = "assistant" | "user" | "system";

export type WorkshopSessionMessage = {
  id: string;
  role: WorkshopSessionMessageRole;
  text: string;
  createdAt: string;
};

export type WorkshopSessionRecord = {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  transcript: WorkshopSessionMessage[];
  piSessionId: string | null;
  activeBuildId?: string;
};

export type WorkshopSessionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  activeBuildId?: string;
};

export type WorkshopSessionAppendMessage = {
  id?: string;
  role: WorkshopSessionMessageRole;
  text: string;
  createdAt?: string;
};

export type WorkshopSessionStoreErrorCode = "workshop_session_not_found";

export class WorkshopSessionStoreError extends Error {
  readonly code: WorkshopSessionStoreErrorCode;
  readonly sessionId?: string;

  constructor(
    message: string,
    code: WorkshopSessionStoreErrorCode,
    sessionId?: string,
  ) {
    super(message);
    this.name = "WorkshopSessionStoreError";
    this.code = code;
    if (sessionId !== undefined) this.sessionId = sessionId;
  }
}

export function resolveWorkshopSessionStoreRoot(): string {
  return globalStageflowHome();
}

export function workshopSessionsDir(storeRoot: string): string {
  return path.join(storeRoot, "workshop", "sessions");
}

export function workshopSessionDir(
  storeRoot: string,
  sessionId: string,
): string {
  return path.join(workshopSessionsDir(storeRoot), guardSessionId(sessionId));
}

export function workshopSessionFilePath(
  storeRoot: string,
  sessionId: string,
): string {
  return path.join(workshopSessionDir(storeRoot, sessionId), "session.json");
}

export function workshopSessionPiFilePath(
  storeRoot: string,
  sessionId: string,
): string {
  return path.join(workshopSessionDir(storeRoot, sessionId), "pi-session.jsonl");
}

function guardSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (
    !trimmed ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed === "."
  ) {
    throw new Error(`invalid workshop session id: ${sessionId}`);
  }
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function truncateWorkshopSessionTitle(text: string): string {
  const collapsed = text.trim().replace(/\s+/g, " ");
  if (collapsed.length <= WORKSHOP_SESSION_TITLE_MAX_LENGTH) return collapsed;
  return collapsed.slice(0, WORKSHOP_SESSION_TITLE_MAX_LENGTH).trimEnd();
}

function parseMessage(value: unknown): WorkshopSessionMessage | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (
    value.role !== "assistant" &&
    value.role !== "user" &&
    value.role !== "system"
  ) {
    return null;
  }
  if (typeof value.text !== "string") return null;
  if (typeof value.createdAt !== "string" || !value.createdAt) return null;
  return {
    id: value.id,
    role: value.role,
    text: value.text,
    createdAt: value.createdAt,
  };
}

export function parseWorkshopSessionRecord(
  value: unknown,
): WorkshopSessionRecord | null {
  if (!isPlainObject(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (typeof value.title !== "string") return null;
  if (typeof value.createdAt !== "string" || !value.createdAt) return null;
  if (typeof value.updatedAt !== "string" || !value.updatedAt) return null;
  if (!Array.isArray(value.transcript)) return null;
  if (value.piSessionId !== null && typeof value.piSessionId !== "string") {
    return null;
  }
  if (
    value.activeBuildId !== undefined &&
    value.activeBuildId !== null &&
    typeof value.activeBuildId !== "string"
  ) {
    return null;
  }

  const transcript: WorkshopSessionMessage[] = [];
  for (const entry of value.transcript) {
    const msg = parseMessage(entry);
    if (!msg) return null;
    transcript.push(msg);
  }

  const activeBuildId =
    typeof value.activeBuildId === "string" ? value.activeBuildId.trim() : "";

  return {
    version: 1,
    id: value.id,
    title: value.title,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    transcript,
    piSessionId: value.piSessionId,
    ...(activeBuildId ? { activeBuildId } : {}),
  };
}

function writeSession(
  storeRoot: string,
  record: WorkshopSessionRecord,
): void {
  const dir = workshopSessionDir(storeRoot, record.id);
  mkdirSync(dir, { recursive: true });
  const payload: WorkshopSessionRecord = {
    version: 1,
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    transcript: record.transcript,
    piSessionId: record.piSessionId,
    ...(record.activeBuildId ? { activeBuildId: record.activeBuildId } : {}),
  };
  writeFileSync(
    workshopSessionFilePath(storeRoot, record.id),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

export function readWorkshopSession(
  storeRoot: string,
  sessionId: string,
): WorkshopSessionRecord | null {
  let id: string;
  try {
    id = guardSessionId(sessionId);
  } catch {
    return null;
  }
  const filePath = workshopSessionFilePath(storeRoot, id);
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const parsed = parseWorkshopSessionRecord(raw);
    if (!parsed || parsed.id !== id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createWorkshopSession(
  storeRoot: string,
  options?: {
    id?: string;
    now?: Date;
    piSessionId?: string | null;
  },
): WorkshopSessionRecord {
  const id = options?.id?.trim() || randomUUID();
  guardSessionId(id);
  if (readWorkshopSession(storeRoot, id)) {
    throw new Error(`workshop session already exists: ${id}`);
  }
  const now = (options?.now ?? new Date()).toISOString();
  const record: WorkshopSessionRecord = {
    version: 1,
    id,
    title: "",
    createdAt: now,
    updatedAt: now,
    transcript: [],
    piSessionId: options?.piSessionId ?? null,
  };
  writeSession(storeRoot, record);
  return record;
}

export function getWorkshopSession(
  storeRoot: string,
  sessionId: string,
): WorkshopSessionRecord {
  const record = readWorkshopSession(storeRoot, sessionId);
  if (!record) {
    throw new WorkshopSessionStoreError(
      `workshop_session_not_found: ${sessionId}`,
      "workshop_session_not_found",
      sessionId,
    );
  }
  return record;
}

export function listWorkshopSessions(
  storeRoot: string,
): WorkshopSessionSummary[] {
  const dir = workshopSessionsDir(storeRoot);
  if (!existsSync(dir)) return [];
  const summaries: WorkshopSessionSummary[] = [];
  for (const name of readdirSync(dir)) {
    const record = readWorkshopSession(storeRoot, name);
    if (!record) continue;
    summaries.push({
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.activeBuildId ? { activeBuildId: record.activeBuildId } : {}),
    });
  }
  summaries.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) {
      return a.updatedAt < b.updatedAt ? 1 : -1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return summaries;
}

export function appendWorkshopSessionMessages(
  storeRoot: string,
  sessionId: string,
  messages: readonly WorkshopSessionAppendMessage[],
  options?: { now?: Date },
): WorkshopSessionRecord {
  const record = getWorkshopSession(storeRoot, sessionId);
  const now = (options?.now ?? new Date()).toISOString();
  let title = record.title;
  const appended: WorkshopSessionMessage[] = [];
  for (const msg of messages) {
    const entry: WorkshopSessionMessage = {
      id: msg.id?.trim() || randomUUID(),
      role: msg.role,
      text: msg.text,
      createdAt: msg.createdAt || now,
    };
    appended.push(entry);
    if (!title && entry.role === "user" && entry.text.trim()) {
      title = truncateWorkshopSessionTitle(entry.text);
    }
  }
  const next: WorkshopSessionRecord = {
    ...record,
    title,
    updatedAt: now,
    transcript: [...record.transcript, ...appended],
  };
  writeSession(storeRoot, next);
  return next;
}

export function updateWorkshopSessionPiSessionId(
  storeRoot: string,
  sessionId: string,
  piSessionId: string | null,
  options?: { now?: Date },
): WorkshopSessionRecord {
  const record = getWorkshopSession(storeRoot, sessionId);
  const next: WorkshopSessionRecord = {
    ...record,
    piSessionId,
    updatedAt: (options?.now ?? new Date()).toISOString(),
  };
  writeSession(storeRoot, next);
  return next;
}

export function updateWorkshopSessionActiveBuildId(
  storeRoot: string,
  sessionId: string,
  activeBuildId: string | null,
  options?: { now?: Date },
): WorkshopSessionRecord {
  const record = getWorkshopSession(storeRoot, sessionId);
  const trimmed = activeBuildId?.trim() ?? "";
  const next: WorkshopSessionRecord = {
    ...record,
    updatedAt: (options?.now ?? new Date()).toISOString(),
  };
  if (trimmed) {
    next.activeBuildId = trimmed;
  } else {
    delete next.activeBuildId;
  }
  writeSession(storeRoot, next);
  return next;
}

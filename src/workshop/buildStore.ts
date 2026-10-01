import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  parseDraftPackageBody,
  type DraftPackage,
} from "../config/draftPackage.js";
import { globalStageflowHome } from "../project/globalHome.js";

export type WorkshopBuildRecord = {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  draft: DraftPackage;
  projectRoot: string | null;
  relativePath: string | null;
};

export type WorkshopBuildSummary = {
  id: string;
  createdAt: string;
  updatedAt: string;
  projectRoot: string | null;
  relativePath: string | null;
};

export type WorkshopBuildCreateInput = {
  draft: DraftPackage;
  id?: string;
  now?: Date;
  projectRoot?: string | null;
  relativePath?: string | null;
};

export type WorkshopBuildUpdate = {
  draft?: DraftPackage;
  projectRoot?: string | null;
  relativePath?: string | null;
};

export type WorkshopBuildStoreErrorCode = "workshop_build_not_found";

export class WorkshopBuildStoreError extends Error {
  readonly code: WorkshopBuildStoreErrorCode;
  readonly buildId?: string;

  constructor(
    message: string,
    code: WorkshopBuildStoreErrorCode,
    buildId?: string,
  ) {
    super(message);
    this.name = "WorkshopBuildStoreError";
    this.code = code;
    if (buildId !== undefined) this.buildId = buildId;
  }
}

export function resolveWorkshopBuildStoreRoot(): string {
  return globalStageflowHome();
}

export function workshopBuildsDir(storeRoot: string): string {
  return path.join(storeRoot, "workshop", "builds");
}

export function workshopBuildFilePath(
  storeRoot: string,
  buildId: string,
): string {
  return path.join(workshopBuildsDir(storeRoot), `${guardBuildId(buildId)}.json`);
}

function guardBuildId(buildId: string): string {
  const trimmed = buildId.trim();
  if (
    !trimmed ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed === "."
  ) {
    throw new Error(`invalid workshop build id: ${buildId}`);
  }
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeTie(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseTieField(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  return normalizeTie(value);
}

function parseStoredDraft(value: unknown): DraftPackage | null {
  const parsed = parseDraftPackageBody(value);
  if ("ok" in parsed) return null;
  return parsed;
}

export function parseWorkshopBuildRecord(
  value: unknown,
): WorkshopBuildRecord | null {
  if (!isPlainObject(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.id !== "string" || !value.id) return null;
  if (typeof value.createdAt !== "string" || !value.createdAt) return null;
  if (typeof value.updatedAt !== "string" || !value.updatedAt) return null;
  const draft = parseStoredDraft(value.draft);
  if (!draft) return null;
  const projectRoot = parseTieField(value.projectRoot);
  if (projectRoot === undefined) return null;
  const relativePath = parseTieField(value.relativePath);
  if (relativePath === undefined) return null;

  return {
    version: 1,
    id: value.id,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    draft,
    projectRoot,
    relativePath,
  };
}

function writeBuild(storeRoot: string, record: WorkshopBuildRecord): void {
  const dir = workshopBuildsDir(storeRoot);
  mkdirSync(dir, { recursive: true });
  const payload: WorkshopBuildRecord = {
    version: 1,
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    draft: record.draft,
    projectRoot: record.projectRoot,
    relativePath: record.relativePath,
  };
  writeFileSync(
    workshopBuildFilePath(storeRoot, record.id),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
}

export function readWorkshopBuild(
  storeRoot: string,
  buildId: string,
): WorkshopBuildRecord | null {
  let id: string;
  try {
    id = guardBuildId(buildId);
  } catch {
    return null;
  }
  const filePath = workshopBuildFilePath(storeRoot, id);
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const parsed = parseWorkshopBuildRecord(raw);
    if (!parsed || parsed.id !== id) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createWorkshopBuild(
  storeRoot: string,
  input: WorkshopBuildCreateInput,
): WorkshopBuildRecord {
  const draft = parseStoredDraft(input.draft);
  if (!draft) {
    throw new Error("draft.pipeline is required");
  }
  const id = input.id?.trim() || randomUUID();
  guardBuildId(id);
  if (readWorkshopBuild(storeRoot, id)) {
    throw new Error(`workshop build already exists: ${id}`);
  }
  const now = (input.now ?? new Date()).toISOString();
  const record: WorkshopBuildRecord = {
    version: 1,
    id,
    createdAt: now,
    updatedAt: now,
    draft,
    projectRoot: normalizeTie(input.projectRoot),
    relativePath: normalizeTie(input.relativePath),
  };
  writeBuild(storeRoot, record);
  return record;
}

export function getWorkshopBuild(
  storeRoot: string,
  buildId: string,
): WorkshopBuildRecord {
  const record = readWorkshopBuild(storeRoot, buildId);
  if (!record) {
    throw new WorkshopBuildStoreError(
      `workshop_build_not_found: ${buildId}`,
      "workshop_build_not_found",
      buildId,
    );
  }
  return record;
}

export function listWorkshopBuilds(storeRoot: string): WorkshopBuildSummary[] {
  const dir = workshopBuildsDir(storeRoot);
  if (!existsSync(dir)) return [];
  const summaries: WorkshopBuildSummary[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -".json".length);
    const record = readWorkshopBuild(storeRoot, id);
    if (!record) continue;
    summaries.push({
      id: record.id,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      projectRoot: record.projectRoot,
      relativePath: record.relativePath,
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

export function updateWorkshopBuild(
  storeRoot: string,
  buildId: string,
  patch: WorkshopBuildUpdate,
  options?: { now?: Date },
): WorkshopBuildRecord {
  const record = getWorkshopBuild(storeRoot, buildId);
  let draft = record.draft;
  if (patch.draft !== undefined) {
    const parsed = parseStoredDraft(patch.draft);
    if (!parsed) {
      throw new Error("draft.pipeline is required");
    }
    draft = parsed;
  }
  const next: WorkshopBuildRecord = {
    ...record,
    id: record.id,
    version: 1,
    updatedAt: (options?.now ?? new Date()).toISOString(),
    draft,
    projectRoot:
      patch.projectRoot === undefined
        ? record.projectRoot
        : normalizeTie(patch.projectRoot),
    relativePath:
      patch.relativePath === undefined
        ? record.relativePath
        : normalizeTie(patch.relativePath),
  };
  writeBuild(storeRoot, next);
  return next;
}

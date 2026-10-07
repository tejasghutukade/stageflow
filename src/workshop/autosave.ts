import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { globalStageflowHome } from "../project/globalHome.js";
import { storeRootFor } from "../runstore/paths.js";
import type { DraftPackage } from "../config/draftPackage.js";

export const WORKSHOP_UNTITLED_AUTOSAVE_KEY = "__untitled__";

export type WorkshopAutosaveChatMessage = {
  id: string;
  role: "assistant" | "user" | "system";
  text: string;
  artifacts?: unknown;
};

export type WorkshopAutosaveDestination = {
  directory: string;
  pipelineFilename?: string;
};

export type WorkshopAutosaveRecord = {
  version: 1;
  key: string;
  updatedAt: string;
  draft: DraftPackage;
  messages: WorkshopAutosaveChatMessage[];
  autoApply: boolean;
  sessionModelOverride?: string | null;
  destination?: WorkshopAutosaveDestination | null;
  savedPath?: string | null;
  savedTaskPath?: string | null;
  diskFingerprints?: Record<string, string>;
};

export function workshopAutosaveSlotKey(
  pipelinePath: string | null | undefined,
): string {
  const trimmed = pipelinePath?.trim();
  if (!trimmed) return WORKSHOP_UNTITLED_AUTOSAVE_KEY;
  return trimmed.replace(/\\/g, "/");
}

export function resolveWorkshopAutosaveStoreRoot(options: {
  projectRoot?: string | null;
  isGitProject?: boolean;
}): string {
  const root = options.projectRoot?.trim();
  if (root && options.isGitProject !== false) {
    return storeRootFor(path.resolve(root));
  }
  return globalStageflowHome();
}

export function workshopAutosaveDir(storeRoot: string): string {
  return path.join(storeRoot, "workshop", "autosave");
}

export function workshopAutosaveFilePath(
  storeRoot: string,
  key: string,
): string {
  const safe = Buffer.from(workshopAutosaveSlotKey(key), "utf8").toString(
    "base64url",
  );
  return path.join(workshopAutosaveDir(storeRoot), `${safe}.json`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseChatMessage(
  value: unknown,
): WorkshopAutosaveChatMessage | null {
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
  const msg: WorkshopAutosaveChatMessage = {
    id: value.id,
    role: value.role,
    text: value.text,
  };
  if (value.artifacts !== undefined) {
    msg.artifacts = value.artifacts;
  }
  return msg;
}

export function parseWorkshopAutosaveRecord(
  value: unknown,
): WorkshopAutosaveRecord | null {
  if (!isPlainObject(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.key !== "string" || !value.key) return null;
  if (typeof value.updatedAt !== "string" || !value.updatedAt) return null;
  if (!isPlainObject(value.draft)) return null;
  if (!isPlainObject(value.draft.pipeline)) return null;
  if (!Array.isArray(value.messages)) return null;
  if (typeof value.autoApply !== "boolean") return null;

  const messages: WorkshopAutosaveChatMessage[] = [];
  for (const entry of value.messages) {
    const msg = parseChatMessage(entry);
    if (!msg) return null;
    messages.push(msg);
  }

  const record: WorkshopAutosaveRecord = {
    version: 1,
    key: value.key,
    updatedAt: value.updatedAt,
    draft: value.draft as DraftPackage,
    messages,
    autoApply: value.autoApply,
  };

  if (
    value.sessionModelOverride === null ||
    typeof value.sessionModelOverride === "string"
  ) {
    record.sessionModelOverride = value.sessionModelOverride;
  }
  if (value.destination === null) {
    record.destination = null;
  } else if (isPlainObject(value.destination)) {
    if (typeof value.destination.directory !== "string") return null;
    record.destination = {
      directory: value.destination.directory,
      ...(typeof value.destination.pipelineFilename === "string"
        ? { pipelineFilename: value.destination.pipelineFilename }
        : {}),
    };
  }
  if (value.savedPath === null || typeof value.savedPath === "string") {
    record.savedPath = value.savedPath;
  }
  if (value.savedTaskPath === null || typeof value.savedTaskPath === "string") {
    record.savedTaskPath = value.savedTaskPath;
  }
  if (value.diskFingerprints !== undefined) {
    if (!isPlainObject(value.diskFingerprints)) return null;
    const fps: Record<string, string> = {};
    for (const [k, v] of Object.entries(value.diskFingerprints)) {
      if (typeof v !== "string") return null;
      fps[k] = v;
    }
    record.diskFingerprints = fps;
  }

  return record;
}

export function readWorkshopAutosave(
  storeRoot: string,
  key: string,
): WorkshopAutosaveRecord | null {
  const filePath = workshopAutosaveFilePath(storeRoot, key);
  if (!existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const parsed = parseWorkshopAutosaveRecord(raw);
    if (!parsed) return null;
    if (parsed.key !== workshopAutosaveSlotKey(key)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeWorkshopAutosave(
  storeRoot: string,
  record: WorkshopAutosaveRecord,
): WorkshopAutosaveRecord {
  const key = workshopAutosaveSlotKey(record.key);
  const next: WorkshopAutosaveRecord = {
    ...record,
    version: 1,
    key,
    updatedAt: record.updatedAt || new Date().toISOString(),
  };
  const dir = workshopAutosaveDir(storeRoot);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    workshopAutosaveFilePath(storeRoot, key),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
  return next;
}

export function clearWorkshopAutosave(storeRoot: string, key: string): boolean {
  const filePath = workshopAutosaveFilePath(storeRoot, key);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

export function fingerprintPath(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const st = statSync(filePath);
  return `${st.size}:${Math.trunc(st.mtimeMs)}`;
}

export function draftPackageDiskRelativePaths(input: {
  pipelinePath: string;
  draft: DraftPackage;
  taskPath?: string | null;
}): string[] {
  const pipelinePath = input.pipelinePath.trim().replace(/\\/g, "/");
  const paths = [pipelinePath];
  const packageDir = path.posix.dirname(pipelinePath);
  for (const stage of input.draft.stages ?? []) {
    if (typeof stage.path !== "string" || !stage.path.trim()) continue;
    const joined = path.posix
      .normalize(path.posix.join(packageDir, stage.path.trim().replace(/\\/g, "/")))
      .replace(/^\.\//, "");
    paths.push(joined);
  }
  if (input.taskPath?.trim()) {
    paths.push(input.taskPath.trim().replace(/\\/g, "/"));
  }
  return [...new Set(paths)];
}

export function fingerprintPackageFiles(
  projectRoot: string,
  relativePaths: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const root = path.resolve(projectRoot);
  for (const rel of relativePaths) {
    const abs = path.resolve(root, rel);
    const relToRoot = path.relative(root, abs);
    if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
      out[rel] = "escaped";
      continue;
    }
    out[rel] = fingerprintPath(abs) ?? "missing";
  }
  return out;
}

export function detectDiskChange(input: {
  baseline?: Record<string, string> | null;
  current: Record<string, string>;
}): { changed: boolean; changedPaths: string[] } {
  const baseline = input.baseline;
  if (!baseline || Object.keys(baseline).length === 0) {
    return { changed: false, changedPaths: [] };
  }
  const keys = new Set([
    ...Object.keys(baseline),
    ...Object.keys(input.current),
  ]);
  const changedPaths: string[] = [];
  for (const key of keys) {
    if ((baseline[key] ?? "missing") !== (input.current[key] ?? "missing")) {
      changedPaths.push(key);
    }
  }
  changedPaths.sort();
  return { changed: changedPaths.length > 0, changedPaths };
}

export type DiskChangeDecision = "reload" | "keep";

export function applyDiskChangeDecision(input: {
  decision: DiskChangeDecision;
  currentFingerprints: Record<string, string>;
}): {
  clearAutosave: boolean;
  nextFingerprints: Record<string, string>;
} {
  if (input.decision === "reload") {
    return {
      clearAutosave: true,
      nextFingerprints: input.currentFingerprints,
    };
  }
  return {
    clearAutosave: false,
    nextFingerprints: input.currentFingerprints,
  };
}

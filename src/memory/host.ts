import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { globalStageflowHome } from "../project/globalHome.js";
import { MEMORY_DESCRIPTION_MAX, MEMORY_PAGE_CAP, isMemoryId } from "./ids.js";

export const MEMORY_ERROR_CODES = [
  "MEMORY_INVALID_ID",
  "MEMORY_INVALID_DESCRIPTION",
  "MEMORY_EXISTS",
  "MEMORY_NOT_FOUND",
  "MEMORY_MISMATCH",
  "MEMORY_UNREADABLE",
  "MEMORY_TOO_LARGE",
  "MEMORY_NOT_ATTACHED",
] as const;

export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;

  constructor(code: MemoryErrorCode) {
    super(code);
    this.name = "MemoryError";
    this.code = code;
  }
}

export type MemoryMeta = { id: string; description: string };

export type MemoryRecord = MemoryMeta & { body: string };

export type MemoryHost = {
  create(input: { id: string; description: string }): Promise<MemoryRecord>;
  list(): Promise<MemoryMeta[]>;
  read(id: string): Promise<string>;
  readMeta(id: string): Promise<MemoryMeta>;
  replace(id: string, body: string): Promise<void>;
};

export function memoryHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.STAGEFLOW_HOME?.trim();
  if (raw) return raw;
  return globalStageflowHome();
}

export function memoryDir(home: string, id: string): string {
  return path.join(home, "memories", id);
}

function checkId(id: string): void {
  if (!isMemoryId(id)) throw new MemoryError("MEMORY_INVALID_ID");
}

function checkDescription(description: string): string {
  const text = description.trim();
  if (text.length < 1 || text.length > MEMORY_DESCRIPTION_MAX) {
    throw new MemoryError("MEMORY_INVALID_DESCRIPTION");
  }
  return text;
}

function checkBody(body: string): void {
  if (typeof body !== "string" || body.length > MEMORY_PAGE_CAP) throw new MemoryError("MEMORY_TOO_LARGE");
}

type InspectResult = { ok: true; meta: MemoryMeta } | { ok: false; code: MemoryErrorCode };

export function inspectMemorySync(home: string, id: string): InspectResult {
  if (!isMemoryId(id)) return { ok: false, code: "MEMORY_INVALID_ID" };
  const file = path.join(memoryDir(home, id), "memory.yaml");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, code: "MEMORY_NOT_FOUND" };
    return { ok: false, code: "MEMORY_UNREADABLE" };
  }
  return inspectYaml(id, text);
}

function inspectYaml(id: string, text: string): InspectResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return { ok: false, code: "MEMORY_UNREADABLE" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, code: "MEMORY_UNREADABLE" };
  }
  const doc = raw as Record<string, unknown>;
  if (doc.version !== 1) return { ok: false, code: "MEMORY_UNREADABLE" };
  if (doc.id !== id) return { ok: false, code: "MEMORY_MISMATCH" };
  if (typeof doc.description !== "string" || doc.description.trim().length < 1 || doc.description.trim().length > MEMORY_DESCRIPTION_MAX) {
    return { ok: false, code: "MEMORY_UNREADABLE" };
  }
  return { ok: true, meta: { id, description: doc.description.trim() } };
}

async function readMetaAt(home: string, id: string): Promise<MemoryMeta> {
  checkId(id);
  const file = path.join(memoryDir(home, id), "memory.yaml");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new MemoryError("MEMORY_NOT_FOUND");
    throw new MemoryError("MEMORY_UNREADABLE");
  }
  const inspected = inspectYaml(id, text);
  if (!inspected.ok) throw new MemoryError(inspected.code);
  return inspected.meta;
}

export function createMemoryHost(home: string): MemoryHost {
  return {
    async create(input) {
      checkId(input.id);
      const description = checkDescription(input.description);
      const dir = memoryDir(home, input.id);
      await mkdir(path.join(home, "memories"), { recursive: true });
      try {
        await mkdir(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new MemoryError("MEMORY_EXISTS");
        throw error;
      }
      const yaml = stringifyYaml(
        { id: input.id, version: 1, description },
        { lineWidth: 0 },
      );
      try {
        await writeFile(path.join(dir, "memory.yaml"), yaml, "utf8");
        await writeFile(path.join(dir, "body.md"), "", "utf8");
      } catch (error) {
        await rm(dir, { recursive: true, force: true });
        throw error;
      }
      return { id: input.id, description, body: "" };
    },

    async list() {
      let names: string[];
      try {
        names = await readdir(path.join(home, "memories"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const metas: MemoryMeta[] = [];
      for (const name of names) {
        const inspected = inspectMemorySync(home, name);
        if (inspected.ok) metas.push(inspected.meta);
      }
      metas.sort((a, b) => a.id.localeCompare(b.id));
      return metas;
    },

    async read(id) {
      await readMetaAt(home, id);
      try {
        return await readFile(path.join(memoryDir(home, id), "body.md"), "utf8");
      } catch {
        throw new MemoryError("MEMORY_UNREADABLE");
      }
    },

    readMeta(id) {
      return readMetaAt(home, id);
    },

    async replace(id, body) {
      await readMetaAt(home, id);
      checkBody(body);
      const dir = memoryDir(home, id);
      const tmp = path.join(dir, `.body.md.${process.pid}.${Date.now()}.tmp`);
      await writeFile(tmp, body, "utf8");
      await rename(tmp, path.join(dir, "body.md"));
    },
  };
}

export function memoryHostFor(env: NodeJS.ProcessEnv = process.env): MemoryHost {
  return createMemoryHost(memoryHome(env));
}

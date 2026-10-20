import { copyFile, link, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { globalStageflowHome } from "../project/globalHome.js";
import {
  MEMORY_CARD_MAX,
  MEMORY_DESCRIPTION_MAX,
  MEMORY_KEY_MAX,
  MEMORY_PAGE_CAP,
  isMemoryId,
  memoryCardFileName,
} from "./ids.js";

const MEMORY_SEARCH_MAX = 20;
const CARD_FILE = /^[0-9a-f]{64}$/;
const COVER_PREVIOUS = ".body.md.prev";

export const MEMORY_ERROR_CODES = [
  "MEMORY_INVALID_ID",
  "MEMORY_INVALID_DESCRIPTION",
  "MEMORY_INVALID_KEY",
  "MEMORY_EXISTS",
  "MEMORY_NOT_FOUND",
  "MEMORY_CARD_EXISTS",
  "MEMORY_CARD_NOT_FOUND",
  "MEMORY_TOO_MANY_CARDS",
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

export type MemoryCardHit = { key: string; snippet: string };

export type MemoryHost = {
  create(input: { id: string; description: string }): Promise<MemoryRecord>;
  list(): Promise<MemoryMeta[]>;
  read(id: string): Promise<string>;
  readMeta(id: string): Promise<MemoryMeta>;
  replace(id: string, body: string): Promise<void>;
  readPreviousCover(id: string): Promise<string>;
  addCard(id: string, key: string, body: string): Promise<void>;
  updateCard(id: string, key: string, body: string): Promise<void>;
  readCard(id: string, key: string): Promise<string>;
  readPreviousCard(id: string, key: string): Promise<string>;
  listCards(id: string): Promise<string[]>;
  searchCards(id: string, query: string): Promise<MemoryCardHit[]>;
  deleteCard(id: string, key: string): Promise<void>;
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

function checkKey(key: string): string {
  if (typeof key !== "string") throw new MemoryError("MEMORY_INVALID_KEY");
  const text = key.trim();
  if (text.length < 1 || text.length > MEMORY_KEY_MAX) throw new MemoryError("MEMORY_INVALID_KEY");
  return text;
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

type CardFile = { key: string; body: string };

function encodeCard(key: string, body: string): string {
  return JSON.stringify({ key, body });
}

function decodeCard(text: string): CardFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new MemoryError("MEMORY_UNREADABLE");
  }
  if (typeof raw !== "object" || raw === null) throw new MemoryError("MEMORY_UNREADABLE");
  const key = (raw as { key?: unknown }).key;
  const body = (raw as { body?: unknown }).body;
  if (typeof key !== "string" || typeof body !== "string") throw new MemoryError("MEMORY_UNREADABLE");
  return { key, body };
}

async function readCardFile(file: string): Promise<CardFile | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new MemoryError("MEMORY_UNREADABLE");
  }
  return decodeCard(text);
}

function cardPaths(dir: string, key: string): { current: string; previous: string; name: string } {
  const name = memoryCardFileName(key);
  return {
    name,
    current: path.join(dir, name),
    previous: path.join(dir, `.${name}.prev`),
  };
}

function tempPath(dir: string, name: string): string {
  return path.join(dir, `.${name}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
}

async function commitNew(dir: string, name: string, content: string): Promise<void> {
  const tmp = tempPath(dir, name);
  try {
    await writeFile(tmp, content, "utf8");
    await link(tmp, path.join(dir, name));
    await rm(tmp, { force: true });
  } catch (error) {
    await rm(tmp, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new MemoryError("MEMORY_CARD_EXISTS");
    throw new MemoryError("MEMORY_UNREADABLE");
  }
}

async function commitReplacing(dir: string, name: string, previousName: string, content: string): Promise<void> {
  const tmp = tempPath(dir, name);
  try {
    await writeFile(tmp, content, "utf8");
    try {
      await copyFile(path.join(dir, name), path.join(dir, previousName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rename(tmp, path.join(dir, name));
  } catch (error) {
    await rm(tmp, { force: true });
    if (error instanceof MemoryError) throw error;
    throw new MemoryError("MEMORY_UNREADABLE");
  }
}

async function currentCards(dir: string): Promise<CardFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MemoryError("MEMORY_NOT_FOUND");
    throw new MemoryError("MEMORY_UNREADABLE");
  }
  const cards: CardFile[] = [];
  for (const name of names) {
    if (!CARD_FILE.test(name)) continue;
    const card = await readCardFile(path.join(dir, name));
    if (card) cards.push(card);
  }
  return cards;
}

function snippetFor(key: string, body: string, query: string): string {
  const needle = query.toLowerCase();
  const bodyAt = body.toLowerCase().indexOf(needle);
  const source = bodyAt >= 0 ? body : key;
  const at = bodyAt >= 0 ? bodyAt : source.toLowerCase().indexOf(needle);
  if (at < 0) return source.slice(0, 80);
  const start = Math.max(0, at - 40);
  const end = Math.min(source.length, at + needle.length + 40);
  return source.slice(start, end);
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
      await commitReplacing(dir, "body.md", COVER_PREVIOUS, body);
    },

    async readPreviousCover(id) {
      await readMetaAt(home, id);
      try {
        return await readFile(path.join(memoryDir(home, id), COVER_PREVIOUS), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MemoryError("MEMORY_NOT_FOUND");
        throw new MemoryError("MEMORY_UNREADABLE");
      }
    },

    async addCard(id, key, body) {
      const dir = memoryDir(home, id);
      await readMetaAt(home, id);
      const trimmed = checkKey(key);
      checkBody(body);
      const paths = cardPaths(dir, trimmed);
      if (await readCardFile(paths.current)) throw new MemoryError("MEMORY_CARD_EXISTS");
      if ((await currentCards(dir)).length >= MEMORY_CARD_MAX) throw new MemoryError("MEMORY_TOO_MANY_CARDS");
      await commitNew(dir, paths.name, encodeCard(trimmed, body));
    },

    async updateCard(id, key, body) {
      const dir = memoryDir(home, id);
      await readMetaAt(home, id);
      const trimmed = checkKey(key);
      checkBody(body);
      const paths = cardPaths(dir, trimmed);
      if (!(await readCardFile(paths.current))) throw new MemoryError("MEMORY_CARD_NOT_FOUND");
      await commitReplacing(dir, paths.name, `.${paths.name}.prev`, encodeCard(trimmed, body));
    },

    async readCard(id, key) {
      await readMetaAt(home, id);
      const trimmed = checkKey(key);
      const card = await readCardFile(cardPaths(memoryDir(home, id), trimmed).current);
      if (!card) throw new MemoryError("MEMORY_CARD_NOT_FOUND");
      return card.body;
    },

    async readPreviousCard(id, key) {
      await readMetaAt(home, id);
      const trimmed = checkKey(key);
      const card = await readCardFile(cardPaths(memoryDir(home, id), trimmed).previous);
      if (!card) throw new MemoryError("MEMORY_CARD_NOT_FOUND");
      return card.body;
    },

    async listCards(id) {
      const dir = memoryDir(home, id);
      await readMetaAt(home, id);
      const keys = (await currentCards(dir)).map((card) => card.key);
      keys.sort((a, b) => a.localeCompare(b));
      return keys;
    },

    async searchCards(id, query) {
      const dir = memoryDir(home, id);
      await readMetaAt(home, id);
      if (typeof query !== "string" || query.length === 0) return [];
      const needle = query.toLowerCase();
      const hits: MemoryCardHit[] = [];
      for (const card of await currentCards(dir)) {
        if (!card.key.toLowerCase().includes(needle) && !card.body.toLowerCase().includes(needle)) continue;
        hits.push({ key: card.key, snippet: snippetFor(card.key, card.body, query) });
      }
      hits.sort((a, b) => a.key.localeCompare(b.key));
      return hits.slice(0, MEMORY_SEARCH_MAX);
    },

    async deleteCard(id, key) {
      const dir = memoryDir(home, id);
      await readMetaAt(home, id);
      const trimmed = checkKey(key);
      const paths = cardPaths(dir, trimmed);
      if (!(await readCardFile(paths.current))) throw new MemoryError("MEMORY_CARD_NOT_FOUND");
      try {
        await rm(paths.current, { force: true });
        await rm(paths.previous, { force: true });
      } catch {
        throw new MemoryError("MEMORY_UNREADABLE");
      }
    },
  };
}

export function memoryHostFor(env: NodeJS.ProcessEnv = process.env): MemoryHost {
  return createMemoryHost(memoryHome(env));
}

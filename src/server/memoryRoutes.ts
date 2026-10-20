import type { IncomingMessage, ServerResponse } from "node:http";
import { MemoryError, type MemoryErrorCode, type MemoryHost } from "../memory/host.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

const MAX_BODY_BYTES = 256 * 1024;

const STATUS: Record<MemoryErrorCode, number> = {
  MEMORY_INVALID_ID: 400,
  MEMORY_INVALID_DESCRIPTION: 400,
  MEMORY_INVALID_KEY: 400,
  MEMORY_TOO_LARGE: 400,
  MEMORY_TOO_MANY_CARDS: 400,
  MEMORY_NOT_ATTACHED: 403,
  MEMORY_NOT_FOUND: 404,
  MEMORY_CARD_NOT_FOUND: 404,
  MEMORY_EXISTS: 409,
  MEMORY_CARD_EXISTS: 409,
  MEMORY_MISMATCH: 422,
  MEMORY_UNREADABLE: 500,
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new MemoryError("MEMORY_TOO_LARGE");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new MemoryError("MEMORY_INVALID_ID");
  }
}

function memoryId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new MemoryError("MEMORY_INVALID_ID");
  }
}

function queryKey(req: IncomingMessage): string | null {
  const raw = req.url ?? "";
  const mark = raw.indexOf("?");
  if (mark < 0) return null;
  const params = new URLSearchParams(raw.slice(mark + 1));
  if (!params.has("key")) return null;
  return params.get("key") ?? "";
}

function textField(value: unknown, code: MemoryErrorCode): string {
  if (typeof value !== "string") throw new MemoryError(code);
  return value;
}

export async function handleMemoryRoutes(
  req: IncomingMessage,
  method: string,
  pathname: string,
  host: MemoryHost,
  res: ServerResponse,
  json: Json,
): Promise<boolean> {
  const previousCard = pathname.match(/^\/api\/memories\/([^/]+)\/cards\/previous$/);
  const cards = pathname.match(/^\/api\/memories\/([^/]+)\/cards$/);
  const previousCover = pathname.match(/^\/api\/memories\/([^/]+)\/previous$/);
  const detail = pathname.match(/^\/api\/memories\/([^/]+)$/);
  const collection = pathname === "/api/memories";
  if (!collection && !detail && !cards && !previousCard && !previousCover) return false;
  if (cards && method === "POST") return false;

  try {
    if (collection && method === "GET") {
      json(res, 200, { memories: await host.list() });
      return true;
    }
    if (collection && method === "POST") {
      const body = await readBody(req) as { id?: unknown; description?: unknown };
      if (typeof body.id !== "string" || typeof body.description !== "string") {
        throw new MemoryError("MEMORY_INVALID_ID");
      }
      const created = await host.create({ id: body.id, description: body.description });
      json(res, 201, created);
      return true;
    }
    if (detail && method === "GET") {
      const id = memoryId(detail[1]!);
      const meta = await host.readMeta(id);
      const page = await host.read(id);
      json(res, 200, { ...meta, body: page });
      return true;
    }
    if (detail && method === "PATCH") {
      const id = memoryId(detail[1]!);
      const payload = await readBody(req) as { body?: unknown };
      const body = textField(payload.body, "MEMORY_TOO_LARGE");
      await host.replace(id, body);
      const meta = await host.readMeta(id);
      json(res, 200, { ...meta, body });
      return true;
    }
    if (previousCover && method === "GET") {
      const id = memoryId(previousCover[1]!);
      json(res, 200, { body: await host.readPreviousCover(id) });
      return true;
    }
    if (cards && method === "GET") {
      const id = memoryId(cards[1]!);
      const key = queryKey(req);
      if (key === null) {
        json(res, 200, { keys: await host.listCards(id) });
        return true;
      }
      json(res, 200, { body: await host.readCard(id, key) });
      return true;
    }
    if (cards && method === "PATCH") {
      const id = memoryId(cards[1]!);
      const payload = await readBody(req) as { key?: unknown; body?: unknown };
      const key = textField(payload.key, "MEMORY_INVALID_KEY");
      const body = textField(payload.body, "MEMORY_TOO_LARGE");
      await host.updateCard(id, key, body);
      json(res, 200, { body });
      return true;
    }
    if (cards && method === "DELETE") {
      const id = memoryId(cards[1]!);
      const payload = await readBody(req) as { key?: unknown };
      await host.deleteCard(id, textField(payload.key, "MEMORY_INVALID_KEY"));
      json(res, 200, { removed: true });
      return true;
    }
    if (previousCard && method === "GET") {
      const id = memoryId(previousCard[1]!);
      const key = queryKey(req);
      if (key === null) throw new MemoryError("MEMORY_INVALID_KEY");
      json(res, 200, { body: await host.readPreviousCard(id, key) });
      return true;
    }
  } catch (error) {
    const code = error instanceof MemoryError ? error.code : "MEMORY_UNREADABLE";
    json(res, STATUS[code], { code });
    return true;
  }
  return false;
}

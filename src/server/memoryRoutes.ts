import type { IncomingMessage, ServerResponse } from "node:http";
import { MemoryError, type MemoryErrorCode, type MemoryHost } from "../memory/host.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

const MAX_BODY_BYTES = 256 * 1024;

const STATUS: Record<MemoryErrorCode, number> = {
  MEMORY_INVALID_ID: 400,
  MEMORY_INVALID_DESCRIPTION: 400,
  MEMORY_TOO_LARGE: 400,
  MEMORY_NOT_ATTACHED: 403,
  MEMORY_NOT_FOUND: 404,
  MEMORY_EXISTS: 409,
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

export async function handleMemoryRoutes(
  req: IncomingMessage,
  method: string,
  pathname: string,
  host: MemoryHost,
  res: ServerResponse,
  json: Json,
): Promise<boolean> {
  const detail = pathname.match(/^\/api\/memories\/([^/]+)$/);
  const collection = pathname === "/api/memories";
  if (!collection && !detail) return false;

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
      let id: string;
      try {
        id = decodeURIComponent(detail[1]!);
      } catch {
        throw new MemoryError("MEMORY_INVALID_ID");
      }
      const meta = await host.readMeta(id);
      const page = await host.read(id);
      json(res, 200, { ...meta, body: page });
      return true;
    }
  } catch (error) {
    const code = error instanceof MemoryError ? error.code : "MEMORY_UNREADABLE";
    json(res, STATUS[code], { code });
    return true;
  }
  return false;
}

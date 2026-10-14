import type { IncomingMessage, ServerResponse } from "node:http";
import { ChannelError } from "../channels/errors.js";
import { channelErrorStatus } from "../channels/errorInfo.js";
import type { ChannelService } from "../channels/service.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

const MAX_BODY_BYTES = 65536;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new ChannelError("CHANNEL_RESOURCE_LIMIT");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ChannelError("CHANNEL_INVALID_INPUT");
  }
}

/**
 * Listing, live checks and edits. Request bodies carry secret values on the way in only; nothing
 * the API returns contains one, and failures answer with a code, never the request or its values.
 */
export async function handleChannelRoutes(
  req: IncomingMessage, method: string, pathname: string, service: ChannelService, res: ServerResponse, json: Json,
): Promise<boolean> {
  const idMatch = pathname.match(/^\/api\/connections\/([^/]+)(?:\/(check|validate-target))?$/);
  const isCollection = pathname === "/api/connections";
  const isTest = pathname === "/api/connections/test";
  const isMeta = pathname === "/api/connections/meta";
  if (!isCollection && !isTest && !isMeta && !idMatch) return false;

  try {
    if (isMeta && method === "GET") { json(res, 200, service.meta()); return true; }
    if (isCollection && method === "GET") { json(res, 200, service.list()); return true; }
    if (isCollection && method === "POST") { json(res, 201, await service.create(await readBody(req))); return true; }
    if (isTest && method === "POST") { json(res, 200, await service.test(await readBody(req))); return true; }
    if (idMatch) {
      let id: string;
      try {
        id = decodeURIComponent(idMatch[1]!);
      } catch {
        throw new ChannelError("CHANNEL_INVALID_INPUT");
      }
      if (idMatch[2] === "check" && method === "POST") {
        const health = await service.checkNow(id);
        if (health) json(res, 200, health); else json(res, 404, { code: "CHANNEL_NOT_FOUND" });
        return true;
      }
      if (idMatch[2] === "validate-target" && method === "POST") {
        json(res, 200, service.validateTarget(id, await readBody(req)));
        return true;
      }
      if (!idMatch[2] && method === "PATCH") { json(res, 200, await service.update(id, await readBody(req))); return true; }
      if (!idMatch[2] && method === "DELETE") { await service.remove(id); json(res, 200, { removed: true }); return true; }
    }
  } catch (error) {
    const code = error instanceof ChannelError ? error.code : "CHANNEL_STORAGE_FAILED";
    json(res, channelErrorStatus(code), { code });
    return true;
  }
  return false;
}

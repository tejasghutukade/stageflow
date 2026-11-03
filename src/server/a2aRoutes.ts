import type { IncomingMessage, ServerResponse } from "node:http";
import { A2aManagementError, type A2aManagement } from "../a2a/management.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

const MAX_BODY_BYTES = 65536;

class BodyError extends Error {}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BodyError("Request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BodyError("Request body is not valid JSON");
  }
}

function field(body: unknown, name: string): unknown {
  return body && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
}

/**
 * A2A management: turn it on, callers, published pipelines, reload. Scopes come from the method like
 * every other Host API route (GET reads, the rest drive). A caller's token is in exactly one response,
 * the one that creates it; failures answer with a code and a message that never carries a token.
 */
export async function handleA2aRoutes(
  req: IncomingMessage, method: string, pathname: string, management: A2aManagement, res: ServerResponse, json: Json,
): Promise<boolean> {
  const caller = pathname.match(/^\/api\/a2a\/callers\/([^/]+)$/);
  const publication = pathname.match(/^\/api\/a2a\/publications\/([^/]+)$/);
  const known = new Set([
    "/api/a2a/enable", "/api/a2a/disable", "/api/a2a/reload", "/api/a2a/callers", "/api/a2a/publications", "/api/a2a/publications/preview", "/api/a2a/pipeline-stages",
  ]);
  if (!known.has(pathname) && !caller && !publication) return false;

  try {
    const id = decodeURIComponent((caller ?? publication)?.[1] ?? "");
    if (pathname === "/api/a2a/enable" && method === "POST") {
      const publicUrl = field(await readBody(req), "public_url");
      if (publicUrl !== undefined && typeof publicUrl !== "string") throw new A2aManagementError("a2a_invalid_request", "public_url must be a string", 400);
      json(res, 200, await management.enable({ public_url: publicUrl }));
      return true;
    }
    if (pathname === "/api/a2a/disable" && method === "POST") { json(res, 200, await management.disable()); return true; }
    if (pathname === "/api/a2a/pipeline-stages" && method === "GET") {
      const query = new URL(req.url ?? "", "http://localhost").searchParams;
      const projectRoot = query.get("project_root");
      const pipeline = query.get("pipeline");
      if (!projectRoot || !pipeline) throw new A2aManagementError("a2a_invalid_request", "project_root and pipeline are required", 400);
      json(res, 200, { stages: await management.pipelineStages(projectRoot, pipeline) });
      return true;
    }
    if (pathname === "/api/a2a/reload" && method === "POST") { json(res, 200, await management.reload()); return true; }
    if (pathname === "/api/a2a/callers" && method === "GET") { json(res, 200, { callers: management.listCallers() }); return true; }
    if (pathname === "/api/a2a/callers" && method === "POST") {
      const callerId = field(await readBody(req), "id");
      if (typeof callerId !== "string") throw new A2aManagementError("a2a_invalid_request", "id is required", 400);
      json(res, 201, await management.createCaller(callerId));
      return true;
    }
    if (caller && method === "DELETE") { json(res, 200, await management.revokeCaller(id)); return true; }
    if (pathname === "/api/a2a/publications" && method === "GET") { json(res, 200, { publications: await management.listPublications() }); return true; }
    if (pathname === "/api/a2a/publications" && method === "POST") { json(res, 201, await management.createPublication(await readBody(req))); return true; }
    if (pathname === "/api/a2a/publications/preview" && method === "POST") { json(res, 200, await management.previewPublication(await readBody(req))); return true; }
    if (publication && method === "GET") { json(res, 200, await management.getPublication(id)); return true; }
    if (publication && method === "PATCH") { json(res, 200, await management.updatePublication(id, await readBody(req))); return true; }
    if (publication && method === "DELETE") { json(res, 200, await management.removePublication(id)); return true; }
  } catch (error) {
    if (error instanceof A2aManagementError) {
      json(res, error.status, { error: error.message, code: error.code });
    } else if (error instanceof BodyError) {
      json(res, 400, { error: error.message, code: "a2a_invalid_request" });
    } else if (error instanceof URIError) {
      json(res, 400, { error: "Invalid path", code: "a2a_invalid_request" });
    } else {
      json(res, 500, { error: "A2A management failed", code: "a2a_management_failed" });
    }
    return true;
  }
  return false;
}

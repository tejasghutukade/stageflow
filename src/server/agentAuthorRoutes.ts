import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authorSessionForApi,
  parseAgentAuthorDraft,
  runAgentAuthorTurn,
  undoAgentAuthorTurn,
} from "../agents/authorChat.js";
import { createAuthorSession, listAuthorDrafts, readAuthorSession, saveAuthorSession } from "../agents/authorSessionStore.js";
import { parseWorkshopModel } from "../workshop/modelSettings.js";
import type { OperatorAgentHost } from "../operatorAgent/index.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > 65536) return { __tooLarge: true };
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { __invalid: true };
  } catch {
    return { __invalid: true };
  }
}

export async function handleAgentAuthorRoutes(
  req: IncomingMessage,
  method: string,
  pathname: string,
  projectRoot: string,
  host: OperatorAgentHost,
  res: ServerResponse,
  json: Json,
): Promise<boolean> {
  const chat = pathname === "/api/agent-author/chat";
  const undo = pathname === "/api/agent-author/undo";
  const sessions = pathname === "/api/agent-author/sessions";
  const sessionMatch = /^\/api\/agent-author\/sessions\/([^/]+)$/.exec(pathname);
  if (!chat && !undo && !sessions && !sessionMatch) return false;
  if (sessions && method === "POST") {
    const body = await readBody(req);
    if (body.__tooLarge || body.__invalid) {
      json(res, 400, { code: "agent.invalid" });
      return true;
    }
    json(res, 200, createAuthorSession({
      draft: parseAgentAuthorDraft(body.draft),
      ...(parseWorkshopModel(body.model) ? { model: parseWorkshopModel(body.model) } : {}),
    }));
    return true;
  }
  if (sessions && method === "GET") {
    json(res, 200, { drafts: listAuthorDrafts() });
    return true;
  }
  if (sessionMatch && (method === "GET" || method === "PUT")) {
    const sessionId = decodeURIComponent(sessionMatch[1] ?? "");
    try {
      if (method === "GET") {
        json(res, 200, authorSessionForApi(sessionId));
        return true;
      }
      const body = await readBody(req);
      if (body.__tooLarge || body.__invalid) {
        json(res, 400, { code: "agent.invalid" });
        return true;
      }
      const current = readAuthorSession(sessionId);
      if (!current) {
        json(res, 404, { code: "agent.session_not_found" });
        return true;
      }
      json(res, 200, saveAuthorSession({ ...current, draft: parseAgentAuthorDraft(body.draft) }));
    } catch (err) {
      const code = err instanceof Error ? err.message : "agent.internal";
      json(res, code === "agent.session_not_found" ? 404 : 400, { code: code.startsWith("agent.") ? code : "agent.internal" });
    }
    return true;
  }
  if (!chat && !undo) return false;
  if (method !== "POST") {
    json(res, 405, { code: "agent.invalid" });
    return true;
  }
  const body = await readBody(req);
  if (body.__tooLarge || body.__invalid) {
    json(res, 400, { code: "agent.invalid" });
    return true;
  }
  try {
    if (undo) {
      const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
      if (!sessionId) {
        json(res, 400, { code: "agent.invalid" });
        return true;
      }
      json(res, 200, { draft: undoAgentAuthorTurn(sessionId) });
      return true;
    }
    const message = typeof body.message === "string" ? body.message : "";
    const model = parseWorkshopModel(body.model);
    const result = await runAgentAuthorTurn({
      host,
      projectRoot,
      message,
      ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
      draft: parseAgentAuthorDraft(body.draft),
      ...(model ? { model } : {}),
    });
    json(res, 200, result);
  } catch (err) {
    const code = err instanceof Error ? err.message : "agent.internal";
    const status = code === "agent.session_not_found" ? 404 : code === "agent.conflict" ? 409 : 400;
    json(res, status, { code: code.startsWith("agent.") ? code : "agent.internal" });
  }
  return true;
}

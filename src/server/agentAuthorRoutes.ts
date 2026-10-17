import type { IncomingMessage, ServerResponse } from "node:http";
import { parseAgentAuthorDraft, runAgentAuthorTurn, undoAgentAuthorTurn } from "../agents/authorChat.js";
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
    const result = await runAgentAuthorTurn({
      host,
      projectRoot,
      message,
      ...(typeof body.sessionId === "string" ? { sessionId: body.sessionId } : {}),
      draft: parseAgentAuthorDraft(body.draft),
    });
    json(res, 200, result);
  } catch (err) {
    const code = err instanceof Error ? err.message : "agent.internal";
    const status = code === "agent.session_not_found" ? 404 : code === "agent.conflict" ? 409 : 400;
    json(res, status, { code: code.startsWith("agent.") ? code : "agent.internal" });
  }
  return true;
}

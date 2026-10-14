import type { IncomingMessage, ServerResponse } from "node:http";
import { AgentService } from "../agents/service.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

const MAX_BODY_BYTES = 65536;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return { __tooLarge: true };
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

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export async function handleAgentRoutes(
  req: IncomingMessage,
  method: string,
  pathname: string,
  service: AgentService,
  projectRoot: string,
  res: ServerResponse,
  json: Json,
): Promise<boolean> {
  const item = pathname.match(/^\/api\/agents\/([^/]+)(?:\/(enable|disable|archive|save))?$/);
  const collection = pathname === "/api/agents";
  if (!collection && !item) return false;

  if (item) {
    let id: string;
    try {
      id = decodeURIComponent(item[1]!);
    } catch {
      json(res, 400, { code: "agent.invalid" });
      return true;
    }
    const action = item[2];
    if (!action && method === "GET") {
      const agent = await service.get(projectRoot, id);
      if (!agent || agent.revision === 0) json(res, 404, { code: "agent.not_found" });
      else json(res, 200, agent);
      return true;
    }
    if (action === "enable" && method === "POST") {
      const result = await service.setEnabled(projectRoot, id, true);
      json(res, result.ok ? 200 : result.code === "agent.not_found" ? 404 : 409, result.ok ? result.agent : { code: result.code });
      return true;
    }
    if (action === "disable" && method === "POST") {
      const result = await service.setEnabled(projectRoot, id, false);
      json(res, result.ok ? 200 : result.code === "agent.not_found" ? 404 : 409, result.ok ? result.agent : { code: result.code });
      return true;
    }
    if (action === "archive" && method === "POST") {
      const result = await service.archive(projectRoot, id);
      json(res, result.ok ? 200 : 404, result.ok ? result.agent : { code: result.code });
      return true;
    }
    if (action === "save" && method === "POST") {
      const body = await readBody(req);
      if (body.__tooLarge || body.__invalid || typeof body.baseRevision !== "number") {
        json(res, 400, { code: "agent.invalid" });
        return true;
      }
      const result = await service.save(projectRoot, id, {
        baseRevision: body.baseRevision,
        name: text(body.name) ?? "",
        instructions: text(body.instructions) ?? "",
        ...(text(body.description) !== undefined ? { description: text(body.description) } : {}),
      });
      const status = result.ok ? 200 : result.code === "agent.conflict" ? 409 : result.code === "agent.not_found" ? 404 : 400;
      json(res, status, result.ok ? result.agent : { code: result.code });
      return true;
    }
  }

  if (collection && method === "GET") {
    json(res, 200, { agents: await service.list(projectRoot) });
    return true;
  }
  if (collection && method === "POST") {
    const body = await readBody(req);
    if (body.__tooLarge || body.__invalid || !text(body.id) || !text(body.name) || !text(body.instructions)) {
      json(res, 400, { code: "agent.invalid" });
      return true;
    }
    try {
      const agent = await service.create(projectRoot, {
        id: text(body.id)!,
        name: text(body.name)!,
        instructions: text(body.instructions)!,
        ...(text(body.description) !== undefined ? { description: text(body.description) } : {}),
      });
      json(res, 201, agent);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "agent.invalid";
      json(res, code === "agent.exists" ? 409 : 400, { code });
    }
    return true;
  }
  return false;
}

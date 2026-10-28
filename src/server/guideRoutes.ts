import type { IncomingMessage, ServerResponse } from "node:http";
import {
  abortGuideTurn,
  GuideError,
  guideAgentInfo,
  isGuideThreadRunning,
  streamGuideTurn,
} from "../guide/chat.js";
import {
  createGuideThread,
  listGuideThreads,
  readGuideThread,
  setGuideThreadModel,
} from "../guide/threadStore.js";
import type { OperatorAgentHost } from "../operatorAgent/index.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buffer.length;
    if (size > 1_500_000) return { __tooLarge: true };
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

function threadSummary(record: { id: string; title: string; updatedAt: string }) {
  return { id: record.id, title: record.title, updatedAt: record.updatedAt };
}

function canWrite(res: ServerResponse): boolean {
  return !res.writableEnded && !res.destroyed;
}

export async function handleGuideRoutes(
  req: IncomingMessage,
  method: string,
  pathname: string,
  host: OperatorAgentHost,
  res: ServerResponse,
  json: Json,
): Promise<boolean> {
  const root = pathname === "/api/guide";
  const threads = pathname === "/api/guide/threads";
  const threadMatch = /^\/api\/guide\/threads\/([^/]+)$/.exec(pathname);
  const messageMatch = /^\/api\/guide\/threads\/([^/]+)\/messages$/.exec(pathname);
  const stopMatch = /^\/api\/guide\/threads\/([^/]+)\/stop$/.exec(pathname);
  if (!root && !threads && !threadMatch && !messageMatch && !stopMatch) return false;

  if (root && method === "GET") {
    json(res, 200, { agent: guideAgentInfo(host) });
    return true;
  }
  if (threads && method === "GET") {
    json(res, 200, {
      threads: listGuideThreads().map((thread) => ({
        ...thread,
        status: isGuideThreadRunning(thread.id) ? "running" : "open",
      })),
    });
    return true;
  }
  if (threads && method === "POST") {
    const record = createGuideThread();
    json(res, 201, { thread: threadSummary(record) });
    return true;
  }
  if (stopMatch && method === "POST") {
    const threadId = decodeURIComponent(stopMatch[1] ?? "");
    const record = readGuideThread(threadId);
    if (!record) {
      json(res, 404, { code: "guide.not_found", message: "" });
      return true;
    }
    json(res, 200, { ok: true, stopped: abortGuideTurn(threadId) });
    return true;
  }
  if (threadMatch && method === "GET") {
    const threadId = decodeURIComponent(threadMatch[1] ?? "");
    const record = readGuideThread(threadId);
    if (!record) {
      json(res, 404, { code: "guide.not_found", message: "" });
      return true;
    }
    json(res, 200, {
      thread: threadSummary(record),
      status: isGuideThreadRunning(record.id) ? "running" : "open",
      messages: record.messages,
      model: record.model ?? null,
    });
    return true;
  }
  if (threadMatch && method === "PATCH") {
    const threadId = decodeURIComponent(threadMatch[1] ?? "");
    const body = await readBody(req);
    if (body.__tooLarge || body.__invalid) {
      json(res, 400, { code: "guide.invalid", message: "" });
      return true;
    }
    let record = readGuideThread(threadId);
    if (!record) {
      json(res, 404, { code: "guide.not_found", message: "" });
      return true;
    }
    if ("model" in body) {
      if (typeof body.model === "string") {
        const next = setGuideThreadModel(threadId, body.model.trim() || null);
        if (!next) {
          json(res, 404, { code: "guide.not_found", message: "" });
          return true;
        }
        record = next;
      } else if (body.model === null) {
        const next = setGuideThreadModel(threadId, null);
        if (!next) {
          json(res, 404, { code: "guide.not_found", message: "" });
          return true;
        }
        record = next;
      } else {
        json(res, 400, { code: "guide.invalid", message: "" });
        return true;
      }
    }
    json(res, 200, { thread: threadSummary(record), model: record.model ?? null });
    return true;
  }
  if (messageMatch && method === "POST") {
    const threadId = decodeURIComponent(messageMatch[1] ?? "");
    const body = await readBody(req);
    if (body.__tooLarge || body.__invalid) {
      json(res, 400, { code: "guide.invalid", message: "" });
      return true;
    }
    const text = typeof body.text === "string" ? body.text : "";
    let started = false;
    try {
      for await (const frame of streamGuideTurn({
        host,
        threadId,
        text,
        attachments: body.attachments,
        model: typeof body.model === "string" ? body.model : undefined,
      })) {
        if (!canWrite(res)) continue;
        if (!started) {
          started = true;
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-store",
          });
        }
        res.write(`${JSON.stringify(frame)}\n`);
      }
    } catch (err) {
      const code = err instanceof GuideError ? err.code : "guide.failed";
      const status = err instanceof GuideError ? err.status : 500;
      if (!started && canWrite(res)) json(res, status, { code, message: "" });
      else if (started && canWrite(res)) res.write(`${JSON.stringify({ type: "error", code, message: "" })}\n`);
    } finally {
      if (!res.headersSent && canWrite(res)) json(res, 200, { code: "guide.failed", message: "" });
      else if (canWrite(res)) res.end();
    }
    return true;
  }

  json(res, 405, { code: "guide.invalid", message: "" });
  return true;
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { EmailAccounts } from "../email/accounts.js";
import { EmailError, type EmailMailbox } from "../email/port.js";
import type { EmailTriggers } from "../email/triggers.js";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 32768) throw new EmailError("EMAIL_RESOURCE_LIMIT");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new EmailError("EMAIL_INVALID_INPUT");
  }
}

export async function handleEmailRoutes(
  req: IncomingMessage, res: ServerResponse, pathname: string,
  accounts: EmailAccounts, mailbox: EmailMailbox,
  triggers?: EmailTriggers,
): Promise<void> {
  try {
    const method = req.method ?? "GET";
    if (triggers) {
      const triggerMatch = pathname.match(/^\/api\/email\/triggers\/([^/]+)$/);
      if (pathname === "/api/email/triggers" && method === "GET") { json(res, 200, { triggers: triggers.list() }); return; }
      if (pathname === "/api/email/triggers" && method === "POST") { json(res, 201, await triggers.create(await body(req))); return; }
      if (pathname === "/api/email/dispatches" && method === "GET") { json(res, 200, { dispatches: triggers.history() }); return; }
      if (pathname === "/api/email/dispatches/health" && method === "GET") { json(res, 200, triggers.health()); return; }
      const dispatchMatch = pathname.match(/^\/api\/email\/dispatches\/([^/]+)\/(resume|cancel)$/);
      if (dispatchMatch && method === "POST") {
        const input = await body(req);
        if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) throw new EmailError("EMAIL_INVALID_INPUT");
        const key = decodeURIComponent(dispatchMatch[1]);
        if (dispatchMatch[2] === "resume") json(res, 200, triggers.resume(key));
        else { triggers.cancel(key); json(res, 200, { cancelled: true }); }
        return;
      }
      if (triggerMatch) {
        const id = decodeURIComponent(triggerMatch[1]);
        if (method === "GET") { json(res, 200, triggers.get(id)); return; }
        if (method === "PATCH") { json(res, 200, await triggers.update(id, await body(req))); return; }
        if (method === "DELETE") { triggers.remove(id); json(res, 200, { removed: true }); return; }
      }
    }
    if (["/api/email/events", "/api/email/watchers"].includes(pathname) && method === "GET") {
      const adapter = mailbox as EmailMailbox & { events?: { list(): unknown[]; health(): unknown[] } };
      json(res, 200, pathname.endsWith("events") ? { events: adapter.events?.list() ?? [] } : { watchers: adapter.events?.health() ?? [] });
      return;
    }
    if (pathname === "/api/email/submissions" && method === "GET") {
      const adapter = mailbox as EmailMailbox & { submissions?: { list(): unknown[] } };
      json(res, 200, { submissions: adapter.submissions?.list() ?? [] });
      return;
    }
    const match = pathname.match(/^\/api\/email\/accounts\/([^/]+)(?:\/(test|health))?$/);
    if (pathname === "/api/email/accounts" && method === "GET") {
      json(res, 200, { accounts: accounts.list() });
      return;
    }
    if (pathname === "/api/email/accounts" && method === "POST") {
      json(res, 201, accounts.create(await body(req)));
      return;
    }
    if (match) {
      const accountId = decodeURIComponent(match[1]);
      if (!match[2] && method === "GET") {
        json(res, 200, accounts.get(accountId, false));
        return;
      }
      if (!match[2] && method === "PATCH") {
        json(res, 200, accounts.update(accountId, await body(req)));
        return;
      }
      if (!match[2] && method === "DELETE") {
        accounts.remove(accountId);
        json(res, 200, { removed: true });
        return;
      }
      if (match[2] === "health" && method === "GET") {
        json(res, 200, { health: accounts.health(accountId) ?? null });
        return;
      }
      if (match[2] === "test" && method === "POST") {
        const input = await body(req) as { protocol?: unknown };
        if (!input || typeof input !== "object" || Array.isArray(input) ||
          Object.keys(input).some(key => key !== "protocol") ||
          (input.protocol !== undefined && !["imap", "smtp", "both"].includes(String(input.protocol)))) {
          throw new EmailError("EMAIL_INVALID_INPUT");
        }
        json(res, 200, await mailbox.testAccount(accountId, input.protocol as "imap" | "smtp" | "both" | undefined));
        return;
      }
    }
    json(res, 404, { error: "Not found" });
  } catch (error) {
    const fault = error instanceof EmailError ? error : new EmailError("EMAIL_CONNECTION_FAILED", true);
    const status = fault.code === "EMAIL_ACCOUNT_NOT_FOUND" ? 404 :
      fault.code === "EMAIL_ACCOUNT_DISABLED" ? 409 :
      fault.code === "EMAIL_RESOURCE_LIMIT" ? 413 : 400;
    json(res, status, { error: fault.code, code: fault.code, retryable: fault.retryable, ...(fault.unsupportedFields ? { unsupportedFields: fault.unsupportedFields } : {}) });
  }
}

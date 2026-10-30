import type { IncomingMessage, ServerResponse } from "node:http";
import { grantedToolIds, type AgentDefinition } from "../../config/loadAgent.js";
import { isConsumerSafeAgent, loadConsumerSubAgents } from "../consumerSafety.js";
import type { AgentChatController } from "../chatTurn.js";
import { isAgentError } from "../errors.js";
import type { AgentService } from "../service.js";
import type { AgentSession } from "../store.js";
import { BodyError, readJsonBody, writeFrame } from "../ndjson.js";
import { SlidingWindowLimiter } from "./rateLimit.js";
import type { ConsumerAuthorization } from "../../identity/authorization.js";
import { ConsumerAccessError } from "../../identity/types.js";

const SOURCE = "web_public";
const MAX_THREADS = 50;
const MAX_BODY_BYTES = 256 * 1024;
const RESOLVE_TTL_MS = 1_000;
const WAIT_POLL_MS = 1_000;
const VISITOR_ID = /^[A-Za-z0-9_-]{16,64}$/;

export type PublicChatOptions = {
  consumerAuthorization?: ConsumerAuthorization;
  service: AgentService;
  chat: AgentChatController;
  projectRoot: string;
  /** Extra origins allowed to call the API from a browser (a page hosted elsewhere). Same-origin always works. */
  allowedOrigins?: string[];
  now?: () => number;
  logError?: (message: string) => void;
};

type Resolved = { agentId: string; definition: AgentDefinition };

const FRIENDLY: Record<string, { status: number; message: string }> = {
  "identity.verification_required": { status: 401, message: "Sign in to continue." },
  "identity.not_available": { status: 404, message: "This chat isn't available." },
  "identity.setup_required": { status: 503, message: "This chat requires administrator setup." },
  "web_chat.unavailable": { status: 404, message: "This chat isn't available." },
  "web_chat.rate_limited": { status: 429, message: "You're sending messages too quickly. Please wait a moment." },
  "web_chat.message_too_long": { status: 413, message: "That message is too long." },
  "web_chat.busy": { status: 409, message: "Still working on your last message." },
  "web_chat.limit_reached": { status: 409, message: "This conversation has reached its limit. Start a new one." },
  "web_chat.invalid": { status: 400, message: "That request wasn't understood." },
  "web_chat.failed": { status: 500, message: "Something went wrong. Please try again." },
};

class WebChatError extends Error {
  constructor(
    readonly code: string,
    readonly retryAfterSec?: number,
    message?: string,
  ) {
    super(message ?? FRIENDLY[code]?.message ?? code);
  }
}

function errorFrame(error: WebChatError): Record<string, unknown> {
  return {
    type: "error",
    code: error.code,
    message: error.message,
    ...(error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}),
  };
}

function toWebChatError(error: unknown): WebChatError {
  if (error instanceof ConsumerAccessError) return new WebChatError(error.code);
  if (error instanceof WebChatError) return error;
  if (isAgentError(error)) {
    if (error.code === "agent.limit_reached") return new WebChatError("web_chat.limit_reached");
    if (error.code === "agent.session_busy") return new WebChatError("web_chat.busy");
    if (error.code === "agent.disabled" || error.code === "agent.not_found" || error.code === "agent.archived") {
      return new WebChatError("web_chat.unavailable");
    }
    if (error.code === "agent.guardrail_blocked") {
      return new WebChatError("web_chat.failed", undefined, "I can't help with that. Try asking differently.");
    }
  }
  return new WebChatError("web_chat.failed");
}

export class PublicWebChat {
  private readonly limiter = new SlidingWindowLimiter();
  private readonly resolved = new Map<string, { at: number; value: Resolved | null }>();
  private readonly now: () => number;

  constructor(private readonly options: PublicChatOptions) {
    this.now = options.now ?? Date.now;
  }

  /** True when `pathname` belongs to this surface (the caller then must not fall through). */
  static owns(pathname: string): boolean {
    return pathname.startsWith("/api/public/chat/");
  }

  async handle(req: IncomingMessage, res: ServerResponse, method: string, pathname: string): Promise<boolean> {
    if (!PublicWebChat.owns(pathname)) return false;
    this.applyCors(req, res);
    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return true;
    }
    try {
      const parts = pathname.slice("/api/public/chat/".length).replace(/\/+$/, "").split("/");
      const [slug = "", threads, threadId, messages] = parts;
      if (parts.length === 2 && threads === "admission" && method === "POST") {
        this.assertOrigin(req);
        const target = await this.resolve(slug);
        if (target.definition.web_chat.access !== "authenticated" || !this.options.consumerAuthorization) throw new ConsumerAccessError("identity.setup_required");
        const body = await readJson(req);
        if (Object.keys(body).some((key) => key !== "connectionId" && key !== "assertion")
          || typeof body.connectionId !== "string" || typeof body.assertion !== "string") throw new WebChatError("web_chat.invalid");
        this.throttle(slug, req.socket.remoteAddress ?? "unknown", req, target, "thread");
        const token = await this.options.consumerAuthorization.admit(body.connectionId, target.agentId, body.assertion);
        const admitted = this.options.consumerAuthorization.store.authenticate(token, target.agentId);
        return this.json(res, 201, { token, tokenType: "Bearer", expiresIn: Math.max(0, Math.floor((admitted.expiresAt - this.now()) / 1000)) });
      }
      if (parts.length === 3 && threads === "oidc" && (threadId === "start" || threadId === "callback")) {
        const target = await this.resolve(slug);
        if (target.definition.web_chat.access !== "authenticated" || !this.options.consumerAuthorization) throw new ConsumerAccessError("identity.setup_required");
        if (threadId === "start") {
          this.assertOrigin(req);
          if (method !== "POST") throw new WebChatError("web_chat.invalid");
          const body = await readJson(req);
          if (Object.keys(body).some((key) => key !== "connectionId") || typeof body.connectionId !== "string") throw new WebChatError("web_chat.invalid");
          this.throttle(slug, req.socket.remoteAddress ?? "unknown", req, target, "thread");
          const started = await this.options.consumerAuthorization.startOidc(body.connectionId, target.agentId);
          res.setHeader("Set-Cookie", oidcCookie(slug, started.state, 600));
          return this.json(res, 200, { authorizationUrl: started.authorizationUrl });
        }
        if (method !== "GET") throw new WebChatError("web_chat.invalid");
        const currentUrl = this.options.consumerAuthorization.requestUrl(typeof req.headers.host === "string" ? req.headers.host : undefined, req.url ?? "/");
        const state = currentUrl.searchParams.get("state") ?? "";
        if (readCookie(req, "sf_oidc") !== state) throw new ConsumerAccessError("identity.verification_required");
        const token = await this.options.consumerAuthorization.completeOidc(target.agentId, currentUrl);
        const admitted = this.options.consumerAuthorization.store.authenticate(token, target.agentId);
        res.setHeader("Set-Cookie", oidcCookie(slug, "", 0));
        return this.json(res, 201, { token, tokenType: "Bearer", expiresIn: Math.max(0, Math.floor((admitted.expiresAt - this.now()) / 1000)) });
      }
      const shapeOk =
        parts.length === 1 || (threads === "threads" && (parts.length === 2 || parts.length === 3 || (parts.length === 4 && messages === "messages")));
      if (!shapeOk) throw new WebChatError("web_chat.unavailable");
      const target = await this.resolve(slug);

      if (parts.length === 1) {
        if (method !== "GET") throw new WebChatError("web_chat.invalid");
        return this.json(res, 200, { agent: { name: target.definition.name, greeting: target.definition.greeting ?? null } });
      }
      if (method === "POST") this.assertOrigin(req);
      const protectedChat = target.definition.web_chat.access === "authenticated";
      const visitor = protectedChat ? this.consumerSession(req, target) : this.visitorOf(req);
      if (parts.length === 2) return await this.collection(req, res, method, target, visitor);
      const session = this.ownedSession(target, visitor, decodeURIComponent(threadId!));
      if (protectedChat) await this.validateProtectedSession(target, visitor, session);
      if (parts.length === 4) {
        if (method !== "POST") throw new WebChatError("web_chat.invalid");
        return await this.send(req, res, target, visitor, session);
      }
      if (method !== "GET") throw new WebChatError("web_chat.invalid");
      const detail = await this.options.service.getSession(this.options.projectRoot, session.id);
      if (protectedChat) await this.validateProtectedSession(target, visitor, detail.session);
      return this.json(res, 200, {
        thread: this.threadView(detail.session),
        status: detail.session.status === "running" || detail.session.status === "waiting" ? detail.session.status : "open",
        messages: detail.messages.map((message) => ({ id: message.id, role: message.role, text: message.text, createdAt: message.createdAt })),
      });
    } catch (error) {
      const failure = toWebChatError(error);
      if (failure.code === "web_chat.failed") this.options.logError?.(`public web chat failed: ${error instanceof Error ? error.message : String(error)}`);
      if (res.headersSent) {
        if (!res.writableEnded) res.end(`${JSON.stringify(errorFrame(failure))}\n`);
        return true;
      }
      if (failure.retryAfterSec !== undefined) res.setHeader("Retry-After", String(failure.retryAfterSec));
      const { type: _type, ...body } = errorFrame(failure);
      return this.json(res, (FRIENDLY[failure.code] ?? FRIENDLY["web_chat.failed"]!).status, body);
    }
  }

  private async collection(req: IncomingMessage, res: ServerResponse, method: string, target: Resolved, visitor: string): Promise<boolean> {
    const { service, projectRoot } = this.options;
    if (method === "GET") {
      const sessions = service.listSessionsForRef(projectRoot, target.agentId, this.source(target), visitor, MAX_THREADS);
      if (target.definition.web_chat.access === "authenticated") {
        for (const session of sessions) await this.validateProtectedSession(target, visitor, session);
      }
      return this.json(res, 200, { threads: sessions.map((session) => this.threadView(session)) });
    }
    if (method !== "POST") throw new WebChatError("web_chat.invalid");
    this.throttle(target.definition.web_chat.slug ?? "", visitor, req, target, "thread");
    const existing = service.listSessionsForRef(projectRoot, target.agentId, this.source(target), visitor, MAX_THREADS);
    if (existing.length >= MAX_THREADS) {
      throw new WebChatError("web_chat.limit_reached", undefined, "You have too many conversations. Please reuse an earlier one.");
    }
    const session = await service.openSession(projectRoot, target.agentId, { source: this.source(target), sourceRef: visitor });
    if (target.definition.web_chat.access === "authenticated") this.options.consumerAuthorization!.store.bind(session.id, visitor, target.agentId, session.revision);
    return this.json(res, 201, { thread: this.threadView(session) });
  }

  private threadView(session: AgentSession): { id: string; title: string; updatedAt: string } {
    return { id: session.id, title: session.title ?? "New chat", updatedAt: session.updatedAt };
  }

  private ownedSession(target: Resolved, visitor: string, threadId: string): AgentSession {
    const found = this.options.service.listSessionsForRef(this.options.projectRoot, target.agentId, this.source(target), visitor, 500).find((session) => session.id === threadId);
    if (!found) throw new WebChatError("web_chat.unavailable");
    return found;
  }

  /* ---------- sending ---------- */

  private async send(req: IncomingMessage, res: ServerResponse, target: Resolved, visitor: string, session: AgentSession): Promise<boolean> {
    const { service, chat, projectRoot } = this.options;
    const slug = target.definition.web_chat.slug ?? "";
    this.throttle(slug, visitor, req, target, "message");
    const body = await readJson(req);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length === 0) throw new WebChatError("web_chat.invalid");
    if (text.length > target.definition.web_chat.max_message_chars) throw new WebChatError("web_chat.message_too_long");
    const current = await service.getSession(projectRoot, session.id);
    if (current.session.status === "running" || current.session.status === "waiting") throw new WebChatError("web_chat.busy");

    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    let finished = false;
    let writes = Promise.resolve();
    const write = (frame: unknown) => {
      writes = writes.then(async () => {
        if (target.definition.web_chat.access === "authenticated") await this.validateProtectedSession(target, visitor, session);
        await writeFrame(res, frame);
      });
      void writes.catch(() => undefined);
    };
    res.once("close", () => {
      if (!finished) chat.stop(session.id);
    });

    // An operator may need to approve a tool: tell the visitor once per pending approval, never what it is.
    let announced: string | null = null;
    const watcher = setInterval(() => {
      try {
        const pending = service.pendingApprovalFor(projectRoot, session.id);
        if (pending && pending !== announced) {
          announced = pending;
          write({ type: "waiting" });
        }
      } catch {
        // a lookup failure must not fail the turn
      }
    }, WAIT_POLL_MS);

    try {
      const detail = await chat.send({
        projectRoot,
        agentId: target.agentId,
        sessionId: session.id,
        text,
        source: SOURCE,
        ...(target.definition.web_chat.access === "authenticated" ? { consumerSessionId: visitor } : {}),
        onDelta: (delta) => write({ type: "delta", text: delta }),
      });
      finished = true;
      if (target.definition.web_chat.access === "authenticated") await this.validateProtectedSession(target, visitor, session);
      const reply = [...detail.messages].reverse().find((message) => message.role === "assistant");
      write(
        reply
          ? { type: "done", message: { id: reply.id, role: "assistant", text: reply.text, createdAt: reply.createdAt } }
          : { type: "done", message: null },
      );
      await writes;
    } catch (error) {
      finished = true;
      const failure = toWebChatError(error);
      if (failure.code === "web_chat.failed") this.options.logError?.(`public web chat turn failed: ${error instanceof Error ? error.message : String(error)}`);
      await writes.catch(() => undefined);
      writes = writeFrame(res, errorFrame(failure));
    } finally {
      clearInterval(watcher);
      await writes.catch(() => undefined);
      if (!res.writableEnded && !res.destroyed) res.end();
    }
    return true;
  }

  /* ---------- plumbing ---------- */

  private source(target: Resolved): string {
    return target.definition.web_chat.access === "authenticated" ? "web_consumer" : SOURCE;
  }

  private async validateProtectedSession(target: Resolved, visitor: string, session: AgentSession): Promise<void> {
    const live = await this.options.service.get(this.options.projectRoot, target.agentId);
    if (!live.definition?.enabled || live.agent.revision !== session.revision) throw new ConsumerAccessError("identity.not_available");
    await this.options.consumerAuthorization!.validateConversation(session.id, visitor, target.agentId, session.revision);
  }

  private consumerSession(req: IncomingMessage, target: Resolved): string {
    const auth = this.options.consumerAuthorization;
    if (!auth) throw new ConsumerAccessError("identity.setup_required");
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new ConsumerAccessError("identity.verification_required");
    return auth.store.authenticate(header.slice(7), target.agentId).sessionId;
  }

  private assertOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    if (!origin) return;
    let same = false;
    try {
      const url = new URL(origin);
      same = ["https:", "http:"].includes(url.protocol) && url.origin === origin && url.host === req.headers.host;
    } catch { same = false; }
    if (!same && !(this.options.allowedOrigins ?? []).includes(origin)) throw new WebChatError("web_chat.invalid");
  }

  private async resolve(slug: string): Promise<Resolved> {
    const now = this.now();
    const cached = this.resolved.get(slug);
    if (cached && cached.value?.definition.web_chat.access !== "authenticated" && now - cached.at < RESOLVE_TTL_MS) {
      if (!cached.value) throw new WebChatError("web_chat.unavailable");
      await this.assertPublication(cached.value);
      return cached.value;
    }
    const value = /^[a-z0-9]{16,32}$/.test(slug) ? await this.options.service.findWebChatAgent(this.options.projectRoot, slug) : null;
    this.resolved.set(slug, { at: now, value });
    if (this.resolved.size > 500) this.resolved.clear();
    if (!value) throw new WebChatError("web_chat.unavailable");
    await this.assertPublication(value);
    return value;
  }

  private async assertPublication(target: Resolved): Promise<void> {
    const definition = target.definition;
    const authenticated = definition.web_chat.access === "authenticated";
    if (!isConsumerSafeAgent(definition) || (definition.sub_agents.length > 0 && !authenticated)) throw new ConsumerAccessError("identity.setup_required");
    const safeSubAgents = definition.sub_agents.length === 0 ? [] : await loadConsumerSubAgents(definition, async (id) => {
      try { return (await this.options.service.get(this.options.projectRoot, id)).definition; } catch { return null; }
    });
    if (!safeSubAgents) throw new ConsumerAccessError("identity.setup_required");
    const allowed = new Set(["orders.status", ...safeSubAgents.map((id) => `agent:${id}`)]);
    const tools = [...grantedToolIds(definition)];
    if (tools.some((tool) => !authenticated || !allowed.has(tool)) || (authenticated && !this.options.consumerAuthorization)) {
      throw new ConsumerAccessError("identity.setup_required");
    }
  }

  private visitorOf(req: IncomingMessage): string {
    const raw = req.headers["x-visitor-id"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value || !VISITOR_ID.test(value)) throw new WebChatError("web_chat.invalid");
    return value;
  }

  /** Messages and new conversations have their own budgets (`kind`); thread creation gets twice the message limit. */
  private throttle(slug: string, visitor: string, req: IncomingMessage, target: Resolved, kind: "message" | "thread"): void {
    const limit = target.definition.web_chat.rate_limit_per_minute * (kind === "thread" ? 2 : 1);
    const now = this.now();
    const perVisitor = this.limiter.take(`${kind}:v:${slug}:${visitor}`, limit, now);
    if (!perVisitor.ok) throw new WebChatError("web_chat.rate_limited", perVisitor.retryAfterSec);
    const address = req.socket.remoteAddress ?? "unknown";
    const perAddress = this.limiter.take(`${kind}:ip:${slug}:${address}`, limit * 3, now);
    if (!perAddress.ok) throw new WebChatError("web_chat.rate_limited", perAddress.retryAfterSec);
  }

  private applyCors(req: IncomingMessage, res: ServerResponse): void {
    const origin = req.headers.origin;
    res.setHeader("Vary", "Origin");
    res.setHeader("Cache-Control", "no-store");
    if (!origin) return;
    // `Origin: null` (sandboxed frames, file pages) and malformed values are not same-origin and get no CORS headers.
    let sameOrigin = false;
    try {
      sameOrigin = req.headers.host !== undefined && new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false;
    }
    if (sameOrigin || (this.options.allowedOrigins ?? []).includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "content-type, x-visitor-id, authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Max-Age", "600");
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): boolean {
    if (!res.headersSent) res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
    return true;
  }
}

function oidcCookie(slug: string, value: string, maxAge: number): string {
  return `sf_oidc=${value}; HttpOnly; Secure; SameSite=Lax; Path=/api/public/chat/${slug}/oidc; Max-Age=${maxAge}`;
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return await readJsonBody(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyError && error.reason === "too_large") throw new WebChatError("web_chat.message_too_long");
    throw new WebChatError("web_chat.invalid");
  }
}

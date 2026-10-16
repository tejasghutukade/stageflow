import type { IncomingMessage, ServerResponse } from "node:http";
import { AgentError, isAgentError } from "../agents/errors.js";
import type { AgentHostContext } from "../agents/hostContext.js";
import { describeToolkit } from "../toolkit/index.js";
import { isSessionStatus, type SessionQuery } from "../agents/store.js";
import { BodyError, readJsonBody, writeFrame } from "../agents/ndjson.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  json: Json;
  host: AgentHostContext;
  projectRoot: string;
  params: string[];
  url: URL;
};

type Route = { method: string; pattern: RegExp; handle: (ctx: Ctx) => Promise<void> };

const MAX_BODY_BYTES = 256 * 1024;
const CONSOLE_ACTOR = { source: "console" as const };

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return await readJsonBody(req, MAX_BODY_BYTES);
  } catch (error) {
    if (!(error instanceof BodyError)) throw error;
    throw new AgentError(
      "agent.invalid",
      error.reason === "too_large" ? "Request body is too large" : error.reason === "not_json" ? "Request body is not JSON" : "Request body must be a JSON object",
    );
  }
}

function requireInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AgentError("agent.invalid", `${name} must be a non-negative integer`);
  }
  return value;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new AgentError("agent.invalid", `${name} is required`);
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function sessionQuery(url: URL): SessionQuery {
  const status = url.searchParams.get("status") ?? undefined;
  if (status !== undefined && !isSessionStatus(status)) {
    throw new AgentError("agent.invalid", "Unknown session status");
  }
  const limit = Number(url.searchParams.get("limit") ?? 25);
  return {
    limit: Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 25,
    ...(status && isSessionStatus(status) ? { status } : {}),
    ...(url.searchParams.get("source") ? { source: url.searchParams.get("source")! } : {}),
    ...(url.searchParams.get("q")?.trim() ? { search: url.searchParams.get("q")!.trim() } : {}),
    ...(url.searchParams.get("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
  };
}

/** A session must belong to the agent named in the path, or the request is a 404. */
async function sessionFor(ctx: Ctx, agentId: string, sessionId: string) {
  const detail = await ctx.host.service.getSession(ctx.projectRoot, sessionId);
  if (detail.session.agentId !== agentId) throw new AgentError("agent.session_not_found");
  return detail;
}

async function chat(ctx: Ctx, agentId: string): Promise<void> {
  const body = await readBody(ctx.req);
  const message = requireText(body.message, "message");
  const sessionId = optionalText(body.sessionId);
  const wantsStream = body.stream === true || String(ctx.req.headers.accept ?? "").includes("application/x-ndjson");
  const send = (onDelta?: (text: string) => void, onSessionOpened?: (id: string) => void) =>
    ctx.host.chat.send({
      projectRoot: ctx.projectRoot,
      agentId,
      text: message,
      source: "console",
      ...(sessionId ? { sessionId } : {}),
      ...(onDelta ? { onDelta } : {}),
      ...(onSessionOpened ? { onSessionOpened } : {}),
    });

  if (!wantsStream) {
    ctx.json(ctx.res, 200, await send());
    return;
  }

  ctx.res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  let writes = Promise.resolve();
  let finished = false;
  let openedId = sessionId;
  ctx.res.once("close", () => {
    if (finished) return;
    if (openedId) ctx.host.chat.stop(openedId);
    else ctx.host.chat.stopOpening(agentId);
  });
  try {
    const detail = await send(
      (text) => {
        writes = writes.then(() => writeFrame(ctx.res, { type: "delta", text }));
      },
      (id) => {
        openedId = id;
        writes = writes.then(() => writeFrame(ctx.res, { type: "session", sessionId: id }));
      },
    );
    finished = true;
    await writes;
    await writeFrame(ctx.res, { type: "done", session: detail });
  } catch (error) {
    finished = true;
    await writes.catch(() => undefined);
    await writeFrame(ctx.res, {
      type: "error",
      code: isAgentError(error) ? error.code : "agent.internal",
      ...(isAgentError(error) && error.message !== error.code ? { message: error.message } : {}),
    });
  } finally {
    if (!ctx.res.writableEnded && !ctx.res.destroyed) ctx.res.end();
  }
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/agents$/,
    handle: async (ctx) => ctx.json(ctx.res, 200, { agents: await ctx.host.service.list(ctx.projectRoot) }),
  },
  {
    method: "POST",
    pattern: /^\/api\/agents$/,
    handle: async (ctx) => {
      const body = await readBody(ctx.req);
      ctx.json(ctx.res, 201, await ctx.host.service.create(ctx.projectRoot, body.definition, CONSOLE_ACTOR));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/agents\/validate$/,
    handle: async (ctx) => {
      const body = await readBody(ctx.req);
      ctx.json(ctx.res, 200, await ctx.host.service.validate(ctx.projectRoot, body.definition));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/stageflow-tools$/,
    handle: async ({ res, json }) => json(res, 200, describeToolkit()),
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/([^/]+)\/channel$/,
    handle: async (ctx) => {
      const detail = await ctx.host.service.get(ctx.projectRoot, ctx.params[0]!);
      const connectionId = detail.definition?.channel?.connection_id ?? null;
      // `listener` is absent for webhook providers and for agents that are disabled.
      const listener = connectionId ? ctx.host.channelListeners?.status(connectionId) : undefined;
      const failed = ctx.host.service.latestUndelivered(ctx.projectRoot, ctx.params[0]!);
      ctx.json(ctx.res, 200, {
        connectionId,
        ...(listener ? { listener } : {}),
        ...(failed ? { lastUndelivered: { turnId: failed.turnId, sessionId: failed.sessionId, state: failed.state, code: failed.errorCode, message: failed.errorMessage, at: failed.updatedAt } } : {}),
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/agents\/([^/]+)\/sessions\/([^/]+)\/turns\/([^/]+)\/delivery\/(resend|delivered)$/,
    handle: async (ctx) => {
      const [agentId, sessionId, turnId, action] = ctx.params as [string, string, string, string];
      const session = await ctx.host.service.getSession(ctx.projectRoot, sessionId);
      if (session.session.agentId !== agentId || !session.turns.some((turn) => turn.id === turnId)) throw new AgentError("agent.session_not_found");
      if (action === "resend") await ctx.host.delivery.resend(turnId);
      else ctx.host.delivery.markDelivered(turnId);
      ctx.json(ctx.res, 200, await ctx.host.service.getSession(ctx.projectRoot, sessionId));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/([^/]+)\/channel\/contact$/,
    handle: async (ctx) => {
      const detail = await ctx.host.service.get(ctx.projectRoot, ctx.params[0]!);
      const connectionId = detail.definition?.channel?.connection_id;
      const found = connectionId ? await ctx.host.channelContact(connectionId) : undefined;
      ctx.json(ctx.res, 200, { connectionId: connectionId ?? null, ...(found ?? {}) });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/sessions$/,
    handle: async (ctx) =>
      ctx.json(
        ctx.res,
        200,
        await ctx.host.service.listAllSessions(ctx.projectRoot, sessionQuery(ctx.url), ctx.url.searchParams.get("agent") || undefined),
      ),
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/approvals$/,
    handle: async (ctx) =>
      ctx.json(ctx.res, 200, { approvals: await ctx.host.service.pendingApprovals(ctx.projectRoot) }),
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/([^/]+)$/,
    handle: async (ctx) => ctx.json(ctx.res, 200, await ctx.host.service.get(ctx.projectRoot, ctx.params[0]!)),
  },
  {
    method: "POST",
    pattern: /^\/api\/agents\/([^/]+)\/save$/,
    handle: async (ctx) => {
      const body = await readBody(ctx.req);
      ctx.json(
        ctx.res,
        200,
        await ctx.host.service.save(
          ctx.projectRoot,
          ctx.params[0]!,
          {
            baseRevision: requireInt(body.baseRevision, "baseRevision"),
            definition: body.definition,
            summary: optionalText(body.summary) ?? null,
          },
          CONSOLE_ACTOR,
        ),
      );
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/agents\/([^/]+)\/(enable|disable)$/,
    handle: async (ctx) =>
      ctx.json(
        ctx.res,
        200,
        await ctx.host.service.setEnabled(ctx.projectRoot, ctx.params[0]!, ctx.params[1] === "enable", CONSOLE_ACTOR),
      ),
  },
  {
    method: "POST",
    pattern: /^\/api\/agents\/([^/]+)\/archive$/,
    handle: async (ctx) => {
      await ctx.host.service.archive(ctx.projectRoot, ctx.params[0]!);
      ctx.json(ctx.res, 200, { archived: true });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/([^/]+)\/revisions$/,
    handle: async (ctx) =>
      ctx.json(ctx.res, 200, { revisions: await ctx.host.service.listRevisions(ctx.projectRoot, ctx.params[0]!) }),
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/([^/]+)\/revisions\/(\d+)$/,
    handle: async (ctx) =>
      ctx.json(ctx.res, 200, await ctx.host.service.getRevision(ctx.projectRoot, ctx.params[0]!, Number(ctx.params[1]))),
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/([^/]+)\/revisions\/(\d+)\/diff\/(\d+)$/,
    handle: async (ctx) =>
      ctx.json(ctx.res, 200, {
        lines: await ctx.host.service.diffRevisions(
          ctx.projectRoot,
          ctx.params[0]!,
          Number(ctx.params[1]),
          Number(ctx.params[2]),
        ),
      }),
  },
  {
    method: "POST",
    pattern: /^\/api\/agents\/([^/]+)\/revisions\/(\d+)\/restore$/,
    handle: async (ctx) => {
      const body = await readBody(ctx.req);
      ctx.json(
        ctx.res,
        200,
        await ctx.host.service.restore(
          ctx.projectRoot,
          ctx.params[0]!,
          { revision: Number(ctx.params[1]), baseRevision: requireInt(body.baseRevision, "baseRevision") },
          CONSOLE_ACTOR,
        ),
      );
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/([^/]+)\/sessions$/,
    handle: async (ctx) =>
      ctx.json(ctx.res, 200, await ctx.host.service.listSessions(ctx.projectRoot, ctx.params[0]!, sessionQuery(ctx.url))),
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/([^/]+)\/sessions\/([^/]+)$/,
    handle: async (ctx) => ctx.json(ctx.res, 200, await sessionFor(ctx, ctx.params[0]!, ctx.params[1]!)),
  },
  {
    method: "GET",
    pattern: /^\/api\/agents\/([^/]+)\/sessions\/([^/]+)\/otlp$/,
    handle: async (ctx) => {
      await sessionFor(ctx, ctx.params[0]!, ctx.params[1]!);
      ctx.res.setHeader("Content-Disposition", `attachment; filename="${ctx.params[1]}.otlp.json"`);
      ctx.json(ctx.res, 200, ctx.host.service.exportSessionOtlp(ctx.projectRoot, ctx.params[1]!));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/agents\/([^/]+)\/sessions\/([^/]+)\/approval\/(approve|deny)$/,
    handle: async (ctx) => {
      await sessionFor(ctx, ctx.params[0]!, ctx.params[1]!);
      const approval = await ctx.host.service.decideApproval(
        ctx.projectRoot,
        ctx.params[1]!,
        ctx.params[2] === "approve" ? "approve" : "deny",
        { kind: "operator" },
      );
      ctx.json(ctx.res, 200, { approval, session: await sessionFor(ctx, ctx.params[0]!, ctx.params[1]!) });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/agents\/([^/]+)\/chat$/,
    handle: async (ctx) => chat(ctx, ctx.params[0]!),
  },
  {
    method: "POST",
    pattern: /^\/api\/agents\/([^/]+)\/chat\/stop$/,
    handle: async (ctx) => {
      const body = await readBody(ctx.req);
      const sessionId = requireText(body.sessionId, "sessionId");
      await sessionFor(ctx, ctx.params[0]!, sessionId);
      ctx.json(ctx.res, 200, { stopped: ctx.host.chat.stop(sessionId) });
    },
  },
];

export async function handleAgentRoutes(
  req: IncomingMessage,
  method: string,
  pathname: string,
  host: AgentHostContext,
  projectRoot: string,
  res: ServerResponse,
  json: Json,
): Promise<boolean> {
  for (const route of routes) {
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    if (route.method !== method) continue;
    try {
      const params = match.slice(1).map((segment) => decodeURIComponent(segment));
      await route.handle({ req, res, json, host, projectRoot, params, url: new URL(req.url ?? pathname, "http://agents") });
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return true;
      }
      if (error instanceof URIError) {
        json(res, 400, { code: "agent.invalid", message: "Malformed path" });
      } else if (isAgentError(error)) {
        json(res, error.httpStatus, {
          code: error.code,
          ...(error.message !== error.code ? { message: error.message } : {}),
          ...(error.issues.length > 0 ? { issues: error.issues } : {}),
        });
      } else {
        throw error;
      }
    }
    return true;
  }
  const known = routes.some((route) => route.pattern.test(pathname));
  if (known) {
    json(res, 405, { code: "agent.method_not_allowed" });
    return true;
  }
  return false;
}

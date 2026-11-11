import type { IncomingMessage, ServerResponse } from "node:http";
import { BodyError, readJsonBody } from "../agents/ndjson.js";
import type { FunctionInvoker, FunctionTestInput, FunctionTestMocks } from "../functions/invoke.js";
import { FunctionError, isFunctionError, type FunctionService } from "../functions/service.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  json: Json;
  service: FunctionService;
  projectRoot: string;
  params: string[];
  invoker?: FunctionInvoker;
};

const MAX_BODY_BYTES = 256 * 1024;
const ACTOR = { source: "console" as const, author: "console" };

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return await readJsonBody(req, MAX_BODY_BYTES);
  } catch (error) {
    if (!(error instanceof BodyError)) throw error;
    throw new FunctionError(
      "function.invalid",
      error.reason === "too_large" ? "Request body is too large" : error.reason === "not_json" ? "Request body is not JSON" : "Request body must be a JSON object",
    );
  }
}

function requireInt(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new FunctionError("function.invalid", `${name} must be a non-negative integer`);
  }
  return value;
}

function requireText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new FunctionError("function.invalid", `${name} is required`);
  return value.trim();
}

const routes: Array<{ method: string; pattern: RegExp; handle: (ctx: Ctx) => Promise<void> }> = [
  {
    method: "GET",
    pattern: /^\/api\/functions$/,
    handle: async (ctx) => ctx.json(ctx.res, 200, { functions: await ctx.service.list(ctx.projectRoot) }),
  },
  {
    method: "POST",
    pattern: /^\/api\/functions$/,
    handle: async (ctx) => {
      const body = await readBody(ctx.req);
      ctx.json(ctx.res, 201, await ctx.service.create(ctx.projectRoot, body.definition, ACTOR));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/functions\/([^/]+)\/revisions\/(\d+)$/,
    handle: async (ctx) => {
      const revision = Number(ctx.params[1]);
      if (!Number.isInteger(revision)) throw new FunctionError("function.invalid", "revision must be an integer");
      ctx.json(ctx.res, 200, await ctx.service.getRevision(ctx.projectRoot, ctx.params[0]!, revision));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/functions\/([^/]+)\/revisions$/,
    handle: async (ctx) => {
      ctx.json(ctx.res, 200, { revisions: await ctx.service.listRevisions(ctx.projectRoot, ctx.params[0]!) });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/functions\/([^/]+)$/,
    handle: async (ctx) => ctx.json(ctx.res, 200, await ctx.service.get(ctx.projectRoot, ctx.params[0]!)),
  },
  {
    method: "PUT",
    pattern: /^\/api\/functions\/([^/]+)$/,
    handle: async (ctx) => {
      const body = await readBody(ctx.req);
      const saved = await ctx.service.save(
        ctx.projectRoot,
        ctx.params[0]!,
        {
          baseRevision: requireInt(body.baseRevision, "baseRevision"),
          definition: body.definition,
          summary: typeof body.summary === "string" ? body.summary : null,
        },
        ACTOR,
      );
      ctx.json(ctx.res, 200, saved);
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/functions\/([^/]+)\/duplicate$/,
    handle: async (ctx) => {
      const body = await readBody(ctx.req);
      ctx.json(ctx.res, 201, await ctx.service.duplicate(ctx.projectRoot, ctx.params[0]!, { id: requireText(body.id, "id") }, ACTOR));
    },
  },
  {
    method: "DELETE",
    pattern: /^\/api\/functions\/([^/]+)$/,
    handle: async (ctx) => ctx.json(ctx.res, 200, await ctx.service.delete(ctx.projectRoot, ctx.params[0]!)),
  },
  {
    method: "POST",
    pattern: /^\/api\/functions\/([^/]+)\/test$/,
    handle: async (ctx) => {
      const invoker = ctx.invoker;
      if (!invoker) {
        ctx.json(ctx.res, 503, { code: "function.store_unavailable" });
        return;
      }
      const body = await readBody(ctx.req);
      ctx.json(ctx.res, 200, await invoker.test(ctx.projectRoot, ctx.params[0]!, testInput(body)));
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/functions\/([^/]+)\/invocations$/,
    handle: async (ctx) => {
      const invoker = ctx.invoker;
      if (!invoker) {
        ctx.json(ctx.res, 503, { code: "function.store_unavailable" });
        return;
      }
      ctx.json(ctx.res, 200, { invocations: invoker.list(ctx.projectRoot, ctx.params[0]!) });
    },
  },
];

export async function handleFunctionRoutes(
  req: IncomingMessage,
  method: string,
  pathname: string,
  service: FunctionService,
  projectRoot: string,
  res: ServerResponse,
  json: Json,
  invoker?: FunctionInvoker,
): Promise<boolean> {
  for (const route of routes) {
    const match = route.pattern.exec(pathname);
    if (!match || route.method !== method) continue;
    try {
      const params = match.slice(1).map((segment) => decodeURIComponent(segment));
      await route.handle({ req, res, json, service, projectRoot, params, invoker });
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return true;
      }
      if (error instanceof URIError) {
        json(res, 400, { code: "function.invalid", message: "Malformed path" });
      } else if (isFunctionError(error)) {
        json(res, error.httpStatus, {
          code: error.code,
          ...(error.message !== error.code ? { message: error.message } : {}),
          ...(error.currentRevision !== undefined ? { current_revision: error.currentRevision } : {}),
          ...(error.usages ? { usages: error.usages } : {}),
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
    json(res, 405, { code: "function.method_not_allowed" });
    return true;
  }
  return false;
}

function testInput(body: Record<string, unknown>): FunctionTestInput {
  const input: FunctionTestInput = { real: body.real === true };
  if (typeof body.source === "string") input.source = body.source;
  if (body.input !== undefined) input.input = body.input;
  if (typeof body.timeoutMs === "number") input.timeoutMs = body.timeoutMs;
  if (typeof body.memoryLimitBytes === "number") input.memoryLimitBytes = body.memoryLimitBytes;
  const mocks = mocksOf(body.mocks);
  if (mocks) input.mocks = mocks;
  return input;
}

function mocksOf(value: unknown): FunctionTestMocks | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const mocks: FunctionTestMocks = {};
  if (Array.isArray(record.files)) {
    mocks.files = [];
    for (const entry of record.files) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const file = entry as Record<string, unknown>;
      if ((file.root !== "artifacts" && file.root !== "workspace") || typeof file.path !== "string" || typeof file.text !== "string") continue;
      mocks.files.push({ root: file.root, path: file.path, text: file.text });
    }
  }
  if (record.env && typeof record.env === "object" && !Array.isArray(record.env)) {
    const env: Record<string, string> = {};
    for (const [key, item] of Object.entries(record.env)) {
      if (typeof item === "string") env[key] = item;
    }
    mocks.env = env;
  }
  return mocks;
}

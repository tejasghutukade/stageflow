import type { IncomingMessage, ServerResponse } from "node:http";
import {
  defaultContext,
  detectPiHome,
  getAuthStatus,
  listProviders,
  loginWithApiKey,
  logoutProvider,
  ProviderAuthError,
  type ProviderAuthContext,
} from "../agent/providerAuth.js";
import {
  answerLoginSession,
  cancelLoginSession,
  getLoginSession,
  startOAuthLoginSession,
} from "../agent/oauthSessionManager.js";

export type ProviderRoutesCtx = {
  cwd: string;
  readJsonBody: (req: IncomingMessage) => Promise<unknown>;
  json: (res: ServerResponse, status: number, body: unknown) => void;
  providerAuthContext?: ProviderAuthContext;
};

export function providerAuthErrorBody(err: unknown): {
  status: number;
  body: { error: string };
} {
  if (err instanceof ProviderAuthError) {
    return { status: err.status, body: { error: err.message } };
  }
  return {
    status: 500,
    body: { error: "Provider auth operation failed" },
  };
}

export async function handleProviderRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ProviderRoutesCtx,
): Promise<boolean> {
  const { cwd, readJsonBody, json } = ctx;
  const authCtx = ctx.providerAuthContext ?? defaultContext;
  const method = req.method ?? "GET";
  const rawUrl = req.url ?? "/";
  const pathname = new URL(rawUrl, "http://localhost").pathname;

  if (method === "GET" && pathname === "/api/providers/detect") {
    try {
      json(res, 200, detectPiHome(cwd));
    } catch (err) {
      const mapped = providerAuthErrorBody(err);
      json(res, mapped.status, mapped.body);
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/providers") {
    try {
      json(res, 200, await listProviders(cwd, authCtx));
    } catch (err) {
      const mapped = providerAuthErrorBody(err);
      json(res, mapped.status, mapped.body);
    }
    return true;
  }

  const providerAuthMatch = pathname.match(/^\/api\/providers\/([^/]+)\/auth$/);
  if (method === "GET" && providerAuthMatch) {
    const providerId = decodeURIComponent(providerAuthMatch[1] ?? "");
    try {
      json(res, 200, {
        provider: await getAuthStatus(cwd, providerId, authCtx),
      });
    } catch (err) {
      const mapped = providerAuthErrorBody(err);
      json(res, mapped.status, mapped.body);
    }
    return true;
  }

  const providerLoginMatch = pathname.match(
    /^\/api\/providers\/([^/]+)\/login$/,
  );
  if (method === "POST" && providerLoginMatch) {
    const providerId = decodeURIComponent(providerLoginMatch[1] ?? "");
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    const record =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const authType = record.authType;
    if (authType === "oauth") {
      try {
        const session = await startOAuthLoginSession(cwd, providerId, authCtx);
        json(res, 200, { ok: true, session });
      } catch (err) {
        const mapped = providerAuthErrorBody(err);
        json(res, mapped.status, mapped.body);
      }
      return true;
    }
    if (authType !== "api_key") {
      json(res, 400, { error: 'authType must be "api_key" or "oauth"' });
      return true;
    }
    const apiKey = record.apiKey;
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      json(res, 400, { error: "apiKey is required" });
      return true;
    }
    try {
      const provider = await loginWithApiKey(cwd, providerId, apiKey, authCtx);
      json(res, 200, { ok: true, provider });
    } catch (err) {
      const mapped = providerAuthErrorBody(err);
      json(res, mapped.status, mapped.body);
    }
    return true;
  }

  const providerLoginSessionMatch = pathname.match(
    /^\/api\/providers\/([^/]+)\/login\/([^/]+)(?:\/(answer|cancel))?$/,
  );
  if (providerLoginSessionMatch) {
    const providerId = decodeURIComponent(providerLoginSessionMatch[1] ?? "");
    const sessionId = decodeURIComponent(providerLoginSessionMatch[2] ?? "");
    const action = providerLoginSessionMatch[3];

    if (method === "GET" && action === undefined) {
      const session = getLoginSession(sessionId);
      if (!session || session.providerId !== providerId) {
        json(res, 404, { error: "Login session not found" });
        return true;
      }
      json(res, 200, { session });
      return true;
    }

    if (method === "POST" && action === "answer") {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return true;
      }
      const record =
        body !== null && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {};
      const value = record.value;
      if (typeof value !== "string") {
        json(res, 400, { error: "value is required" });
        return true;
      }
      try {
        const existing = getLoginSession(sessionId);
        if (!existing || existing.providerId !== providerId) {
          json(res, 404, { error: "Login session not found" });
          return true;
        }
        const session = answerLoginSession(sessionId, value);
        json(res, 200, { ok: true, session });
      } catch (err) {
        const mapped = providerAuthErrorBody(err);
        json(res, mapped.status, mapped.body);
      }
      return true;
    }

    if (method === "POST" && action === "cancel") {
      try {
        await readJsonBody(req);
      } catch {
        // empty body ok
      }
      try {
        const existing = getLoginSession(sessionId);
        if (!existing || existing.providerId !== providerId) {
          json(res, 404, { error: "Login session not found" });
          return true;
        }
        const session = cancelLoginSession(sessionId);
        json(res, 200, { ok: true, session });
      } catch (err) {
        const mapped = providerAuthErrorBody(err);
        json(res, mapped.status, mapped.body);
      }
      return true;
    }
  }

  const providerLogoutMatch = pathname.match(
    /^\/api\/providers\/([^/]+)\/logout$/,
  );
  if (method === "POST" && providerLogoutMatch) {
    const providerId = decodeURIComponent(providerLogoutMatch[1] ?? "");
    try {
      await readJsonBody(req);
    } catch {
      // empty body ok
    }
    try {
      const provider = await logoutProvider(cwd, providerId, authCtx);
      json(res, 200, { ok: true, provider });
    } catch (err) {
      const mapped = providerAuthErrorBody(err);
      json(res, mapped.status, mapped.body);
    }
    return true;
  }

  return false;
}

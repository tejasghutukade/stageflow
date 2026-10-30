import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError } from "zod";
import { BodyError, readJsonBody } from "../agents/ndjson.js";
import type { ConsumerAuthorization } from "../identity/authorization.js";
import { prepareOidcConnection } from "../identity/oidc.js";
import type { ConsumerIdentityStore, HandoffConnection, OidcSigningAlgorithm } from "../identity/store.js";
import {
  ConsumerAccessError,
  type ConsumerPermission,
  type ConsumerScope,
  type OwnedResource,
} from "../identity/types.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  json: Json;
  authorization: ConsumerAuthorization;
  params: string[];
  url: URL;
};

type Route = { method: string; pattern: RegExp; handle: (ctx: Ctx) => Promise<void> };

const MAX_BODY_BYTES = 256 * 1024;
const SCOPES: readonly ConsumerScope[] = ["own", "assigned", "selected", "workspace"];
const ALGORITHMS: readonly OidcSigningAlgorithm[] = ["RS256", "ES256", "EdDSA"];
const TOKEN_FIELDS = new Set([
  "token",
  "access_token",
  "accessToken",
  "id_token",
  "idToken",
  "refresh_token",
  "refreshToken",
  "assertion",
  "clientSecret",
  "client_secret",
  "authorization",
]);

function identityCode(error: unknown): string | undefined {
  const code = error instanceof ConsumerAccessError
    ? error.code
    : typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  return code?.startsWith("identity.") ? code : undefined;
}

function statusFor(code: string): number {
  if (code === "identity.conflict" || code === "identity.verification_required") return 409;
  if (code === "identity.not_available") return 404;
  return 400;
}

function identityFailure(error: unknown): { status: number; code: string } | undefined {
  if (error instanceof ZodError) return { status: 400, code: "identity.setup_required" };
  const code = identityCode(error);
  if (code) return { status: statusFor(code), code };
  if (typeof error === "object" && error !== null && "code" in error && String((error as { code: unknown }).code).startsWith("SQLITE_")) {
    return { status: 400, code: "identity.setup_required" };
  }
  return undefined;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return await readJsonBody(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyError || error instanceof ConsumerAccessError) throw new ConsumerAccessError("identity.setup_required");
    throw error;
  }
}

function requireText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ConsumerAccessError("identity.setup_required");
  return value.trim();
}

function requireSecret(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new ConsumerAccessError("identity.setup_required");
  return value;
}

function requireScope(value: unknown): ConsumerScope {
  if (typeof value !== "string" || !SCOPES.includes(value as ConsumerScope)) throw new ConsumerAccessError("identity.setup_required");
  return value as ConsumerScope;
}

function requireAgents(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new ConsumerAccessError("identity.setup_required");
  }
  return value.map((item) => item.trim());
}

function optionalResources(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ConsumerAccessError("identity.setup_required");
  }
  return value;
}

function requireOrder(value: unknown): OwnedResource {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConsumerAccessError("identity.setup_required");
  const order = value as Record<string, unknown>;
  const assigned = order.assignedAccountIds;
  if (typeof order.id !== "string" || order.id.length === 0
    || typeof order.workspaceId !== "string" || order.workspaceId.length === 0
    || typeof order.ownerAccountId !== "string" || order.ownerAccountId.length === 0
    || typeof order.version !== "string" || order.version.length === 0
    || !Array.isArray(assigned) || assigned.some((item) => typeof item !== "string" || item.length === 0)) {
    throw new ConsumerAccessError("identity.setup_required");
  }
  return {
    id: order.id,
    workspaceId: order.workspaceId,
    ownerAccountId: order.ownerAccountId,
    assignedAccountIds: assigned,
    version: order.version,
  };
}

function algorithmsOf(value: unknown): OidcSigningAlgorithm[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => !ALGORITHMS.includes(item as OidcSigningAlgorithm))) {
    throw new ConsumerAccessError("identity.setup_required");
  }
  return value as OidcSigningAlgorithm[];
}

function handoffConnection(body: Record<string, unknown>): HandoffConnection {
  const jwks = body.publicJwks;
  if (typeof jwks !== "object" || jwks === null || Array.isArray(jwks) || !Array.isArray((jwks as { keys?: unknown }).keys)) {
    throw new ConsumerAccessError("identity.setup_required");
  }
  return {
    id: requireText(body.id),
    issuer: requireText(body.issuer),
    agentId: requireText(body.agentId),
    audience: requireText(body.audience),
    algorithms: algorithmsOf(body.algorithms),
    publicJwks: { keys: (jwks as { keys: Record<string, unknown>[] }).keys },
  };
}

function auditLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") return 50;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new ConsumerAccessError("identity.setup_required");
  return limit;
}

function connectionRow(store: ConsumerIdentityStore, id: string) {
  return store.listConnections().find((row) => row.id === id);
}

function oidcSummary(store: ConsumerIdentityStore, id: string): Record<string, unknown> {
  const setup = store.oidcSetup(id);
  const listed = connectionRow(store, id);
  const summary: Record<string, unknown> = {
    ...setup,
    ...(listed ? { callbackPath: listed.callbackPath, issuerChecks: listed.issuerChecks } : {}),
  };
  delete summary.clientSecret;
  delete summary.secret;
  return summary;
}

function permission(scope: ConsumerScope, agents: string[], resources: string[] | undefined): ConsumerPermission {
  return {
    scope,
    agents,
    actions: ["order:read", "conversation:use"],
    ...(resources ? { resources } : {}),
  };
}

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/api\/identity\/connections$/,
    handle: async (ctx) => {
      ctx.json(ctx.res, 200, { connections: ctx.authorization.store.listConnections() });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/identity\/connections\/handoff$/,
    handle: async (ctx) => {
      const connection = handoffConnection(await readBody(ctx.req));
      ctx.authorization.store.registerHandoff(connection);
      const summary = connectionRow(ctx.authorization.store, connection.id);
      ctx.json(ctx.res, 201, summary ?? { id: connection.id });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/identity\/connections\/oidc$/,
    handle: async (ctx) => {
      const body = await readBody(ctx.req);
      const clientSecret = requireSecret(body.clientSecret);
      const input = {
        id: requireText(body.id),
        issuer: requireText(body.issuer),
        clientId: requireText(body.clientId),
        agentId: requireText(body.agentId),
        redirectUri: requireText(body.redirectUri),
        algorithms: algorithmsOf(body.algorithms),
      };
      ctx.authorization.store.registerOidc(input, clientSecret, false);
      ctx.json(ctx.res, 201, oidcSummary(ctx.authorization.store, input.id));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/identity\/connections\/service$/,
    handle: async (ctx) => {
      const body = await readBody(ctx.req);
      const resources = optionalResources(body.resources);
      const id = requireText(body.id);
      ctx.authorization.store.registerService(id, requireText(body.accountId), permission(requireScope(body.scope), requireAgents(body.agents), resources));
      ctx.json(ctx.res, 201, connectionRow(ctx.authorization.store, id) ?? { id });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/identity\/connections\/([^/]+)\/disable$/,
    handle: async (ctx) => {
      const id = ctx.params[0]!;
      await ctx.authorization.store.disableConnection(id);
      ctx.json(ctx.res, 200, connectionRow(ctx.authorization.store, id) ?? { id });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/identity\/connections\/([^/]+)\/oidc\/prepare$/,
    handle: async (ctx) => {
      const id = ctx.params[0]!;
      try {
        await prepareOidcConnection(ctx.authorization.store, id, false);
      } catch (error) {
        const code = identityCode(error) ?? "identity.setup_required";
        ctx.json(ctx.res, statusFor(code), { code, message: "OIDC preparation failed" });
        return;
      }
      ctx.json(ctx.res, 200, oidcSummary(ctx.authorization.store, id));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/identity\/connections\/([^/]+)\/oidc\/tested$/,
    handle: async (ctx) => {
      const body = await readBody(ctx.req);
      if (Object.keys(body).some((key) => TOKEN_FIELDS.has(key))) throw new ConsumerAccessError("identity.setup_required");
      const id = ctx.params[0]!;
      await ctx.authorization.store.markOidcTested(id);
      ctx.json(ctx.res, 200, { id, tested: true });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/identity\/connections\/([^/]+)\/oidc\/activate$/,
    handle: async (ctx) => {
      const id = ctx.params[0]!;
      if (await ctx.authorization.store.oidcTested(id) !== true) {
        ctx.json(ctx.res, 409, { code: "identity.verification_required" });
        return;
      }
      ctx.authorization.store.activateOidc(id);
      ctx.json(ctx.res, 200, oidcSummary(ctx.authorization.store, id));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/identity\/connections\/([^/]+)\/oidc\/rotate$/,
    handle: async (ctx) => {
      const id = ctx.params[0]!;
      const clientSecret = requireSecret((await readBody(ctx.req)).clientSecret);
      await ctx.authorization.store.rotateOidcSecret(id, clientSecret);
      ctx.json(ctx.res, 200, oidcSummary(ctx.authorization.store, id));
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/identity\/connections\/([^/]+)\/revocation-source$/,
    handle: async (ctx) => {
      const body = await readBody(ctx.req);
      if (!Object.prototype.hasOwnProperty.call(body, "url")) throw new ConsumerAccessError("identity.setup_required");
      const url = body.url;
      if (url !== null && (typeof url !== "string" || url.length === 0)) throw new ConsumerAccessError("identity.setup_required");
      const id = ctx.params[0]!;
      await ctx.authorization.store.setRevocationSource(id, url);
      ctx.json(ctx.res, 200, connectionRow(ctx.authorization.store, id) ?? { id });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/identity\/assignments$/,
    handle: async (ctx) => {
      ctx.json(ctx.res, 200, { assignments: ctx.authorization.store.listAssignments() });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/identity\/assignments$/,
    handle: async (ctx) => {
      const body = await readBody(ctx.req);
      const resources = optionalResources(body.resources);
      let expectedRevision: number | undefined;
      if (body.expectedRevision !== undefined) {
        if (typeof body.expectedRevision !== "number" || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
          throw new ConsumerAccessError("identity.setup_required");
        }
        expectedRevision = body.expectedRevision;
      }
      const mappingSource = body.mappingSource === undefined ? "operator" : requireText(body.mappingSource);
      const id = await ctx.authorization.store.assign(
        requireText(body.connectionId),
        requireText(body.subject),
        requireText(body.accountId),
        mappingSource,
        permission(requireScope(body.scope), requireAgents(body.agents), resources),
        expectedRevision,
      );
      const assignment = ctx.authorization.store.listAssignments().find((row) => row.id === id);
      ctx.json(ctx.res, 201, assignment ?? { id });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/identity\/assignments\/([^/]+)\/revoke$/,
    handle: async (ctx) => {
      const id = ctx.params[0]!;
      ctx.authorization.store.revoke("principal", id);
      const assignment = ctx.authorization.store.listAssignments().find((row) => row.id === id);
      ctx.json(ctx.res, 200, assignment ?? { id, active: false });
    },
  },
  {
    method: "POST",
    pattern: /^\/api\/identity\/preview$/,
    handle: async (ctx) => {
      const body = await readBody(ctx.req);
      const allow = await ctx.authorization.preview(
        requireText(body.accountId),
        requireScope(body.scope),
        optionalResources(body.resources) ?? null,
        requireOrder(body.order),
        AbortSignal.timeout(3_000),
      );
      ctx.json(ctx.res, 200, { allow });
    },
  },
  {
    method: "GET",
    pattern: /^\/api\/identity\/audit$/,
    handle: async (ctx) => {
      ctx.json(ctx.res, 200, { audit: ctx.authorization.store.listAudit(auditLimit(ctx.url)) });
    },
  },
];

export async function handleIdentityRoutes(
  req: IncomingMessage,
  method: string,
  pathname: string,
  url: URL,
  authorization: ConsumerAuthorization,
  res: ServerResponse,
  json: Json,
): Promise<boolean> {
  for (const route of routes) {
    const match = route.pattern.exec(pathname);
    if (!match || route.method !== method) continue;
    try {
      const params = match.slice(1).map((segment) => decodeURIComponent(segment));
      await route.handle({ req, res, json, authorization, params, url });
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return true;
      }
      const failure = identityFailure(error);
      if (!failure) throw error;
      json(res, failure.status, { code: failure.code });
    }
    return true;
  }
  if (routes.some((route) => route.pattern.test(pathname))) {
    json(res, 405, { code: "identity.method_not_allowed" });
    return true;
  }
  return false;
}

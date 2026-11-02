import type { IncomingMessage, ServerResponse } from "node:http";
import { BodyError, readJsonBody } from "../agents/ndjson.js";
import type { ConsumerIdentityRuntime, IdentityEngineChoice } from "../identity/runtime.js";
import { ConsumerAccessError } from "../identity/types.js";

type Json = (res: ServerResponse, status: number, body: unknown) => void;

const MAX_BODY_BYTES = 16 * 1024;
const BASE = "/api/identity/setup";

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    return await readJsonBody(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BodyError || error instanceof ConsumerAccessError) throw new ConsumerAccessError("identity.setup_required");
    throw error;
  }
}

function text(value: unknown, max = 2048): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw new ConsumerAccessError("identity.setup_required");
  return value.trim();
}

function engineChoice(body: Record<string, unknown>): IdentityEngineChoice {
  if (body.kind === "scope") return { kind: "scope" };
  if (body.kind === "cerbos") return { kind: "cerbos", endpoint: text(body.endpoint) };
  throw new ConsumerAccessError("identity.setup_required");
}

/**
 * Operator setup for Host-managed consumer identity. The reply never carries the order API credential or the
 * private signing key; the public signing key is returned so the customer's API can verify signed context.
 */
export async function handleIdentitySetupRoutes(
  req: IncomingMessage,
  method: string,
  pathname: string,
  runtime: ConsumerIdentityRuntime | undefined,
  embeddedEnabled: boolean,
  res: ServerResponse,
  json: Json,
): Promise<boolean> {
  if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return false;
  const tail = pathname.slice(BASE.length);
  if (method === "GET" && tail === "") {
    json(res, 200, runtime ? runtime.status() : { mode: "embedded", enabled: embeddedEnabled });
    return true;
  }
  if (!runtime) {
    json(res, 409, { code: "identity.managed_externally" });
    return true;
  }
  try {
    if (method === "POST" && tail === "/enable") json(res, 200, runtime.enable());
    else if (method === "POST" && tail === "/disable") json(res, 200, runtime.disable());
    else if (method === "POST" && tail === "/engine") json(res, 200, runtime.setEngine(engineChoice(await readBody(req))));
    else if (method === "POST" && tail === "/engine/test") json(res, 200, await runtime.testEngine());
    else if (method === "POST" && tail === "/orders") {
      const body = await readBody(req);
      const credential = body.credential;
      if (credential !== undefined && typeof credential !== "string") throw new ConsumerAccessError("identity.setup_required");
      json(res, 200, await runtime.setOrders({
        endpoint: text(body.endpoint),
        audience: text(body.audience, 256),
        ...(credential !== undefined ? { credential } : {}),
      }));
    } else if (method === "POST" && tail === "/orders/clear") json(res, 200, runtime.clearOrders());
    else if (method === "POST" && tail === "/orders/signing-key") json(res, 200, await runtime.rotateSigningKey());
    else if (method === "POST" && tail === "/orders/test") json(res, 200, await runtime.testOrders(text((await readBody(req)).orderId, 128)));
    else {
      json(res, 405, { code: "identity.method_not_allowed" });
    }
  } catch (error) {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return true;
    }
    if (error instanceof ConsumerAccessError) {
      json(res, error.code === "identity.conflict" || error.code === "identity.verification_required" ? 409 : error.code === "identity.not_available" ? 404 : 400, { code: error.code });
      return true;
    }
    json(res, 400, { code: "identity.setup_required" });
  }
  return true;
}

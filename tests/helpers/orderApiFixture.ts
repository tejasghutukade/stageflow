import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { jwtVerify, type JWTPayload } from "jose";
import type { OwnedResource } from "../../src/identity/types.js";

export const ORDER_API_FIXTURE_SECRET = "stageflow-order-api-fixture-secret-key";
export const ORDER_API_FIXTURE_CREDENTIAL = "downstream-key";
export const ORDER_API_FIXTURE_AUDIENCE = "orders-api";
export const ORDER_API_FIXTURE_PRIVATE_STATUS = "private-fixture-status";

const PRIVATE_STATUS = ORDER_API_FIXTURE_PRIVATE_STATUS;

export type OrderApiFixture = {
  url: string;
  secret: string;
  audience: string;
  credential: string;
  resource(): OwnedResource;
  setVersion(version: string): void;
  peers(): string[];
  close(): Promise<void>;
};

export async function startOrderApiFixture(options: {
  credential?: string;
  chatBearer?: string;
  audience?: string;
  secret?: string;
} = {}): Promise<OrderApiFixture> {
  const credential = options.credential ?? ORDER_API_FIXTURE_CREDENTIAL;
  const chatBearer = options.chatBearer ?? "chat-session-bearer";
  const audience = options.audience ?? ORDER_API_FIXTURE_AUDIENCE;
  const secret = options.secret ?? ORDER_API_FIXTURE_SECRET;
  const key = new TextEncoder().encode(secret);
  let record: OwnedResource = {
    id: "order-a", workspaceId: "w", ownerAccountId: "account-a", assignedAccountIds: [], version: "v1",
  };
  const peers: string[] = [];
  const current = (): OwnedResource => ({ ...record, assignedAccountIds: [...record.assignedAccountIds] });

  const server = createServer(async (req, res) => {
    const peer = req.socket.remoteAddress ?? "";
    peers.push(peer);
    try {
      if (peer !== "127.0.0.1" && peer !== "::ffff:127.0.0.1" && peer !== "::1") return send(res, 403, { error: "forbidden" });
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (req.method !== "POST" || (pathname !== "/stageflow/order-ownership" && pathname !== "/stageflow/order-status")) {
        return send(res, 404, { error: "not_found" });
      }
      const raw = await readBody(req);
      if (!acceptedCredential(bearer(req.headers.authorization), credential, chatBearer)) return send(res, 401, { error: "unauthorized" });
      if (pathname === "/stageflow/order-ownership") {
        const body = jsonObject(raw);
        const owned = current();
        if (body.workspaceId !== owned.workspaceId || body.orderId !== owned.id) return send(res, 404, { error: "not_available" });
        return send(res, 200, owned);
      }
      const context = req.headers["stageflow-authorization"];
      if (typeof context !== "string" || !context) return send(res, 401, { error: "unauthorized" });
      const payload = await verifyContext(context, key, audience);
      if (!payload) return send(res, 401, { error: "unauthorized" });
      const body = jsonObject(raw);
      const owned = current();
      if (body.orderId !== owned.id || payload.resource !== owned.id || payload.workspace !== owned.workspaceId
        || body.expectedVersion !== owned.version || payload.resource_version !== owned.version) {
        return send(res, 404, { error: "not_available" });
      }
      const grant = payload.grant;
      if (typeof payload.sub !== "string" || typeof grant !== "string" || !grant) return send(res, 401, { error: "unauthorized" });
      return send(res, 200, {
        ownership: owned,
        receipt: { principalId: payload.sub, grantId: grant },
        status: { orderId: owned.id, status: PRIVATE_STATUS, updatedAt: "2026-10-30T12:00:00.000Z" },
      });
    } catch {
      if (!res.headersSent) send(res, 400, { error: "invalid_request" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("no port");
  }
  return {
    url: `http://127.0.0.1:${(address as AddressInfo).port}`,
    secret,
    audience,
    credential,
    resource: current,
    setVersion(version: string) {
      if (!version) throw new Error("version required");
      record = { ...record, version };
    },
    peers: () => peers.slice(),
    close: () => close(server),
  };
}

function bearer(header: string | string[] | undefined): string | null {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length);
  return token.length > 0 ? token : null;
}

function acceptedCredential(token: string | null, credential: string, chatBearer: string): boolean {
  if (!token || token === "admin" || token === chatBearer || token.split(".").length === 3) return false;
  const presented = Buffer.from(token);
  const expected = Buffer.from(credential);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

async function verifyContext(token: string, key: Uint8Array, audience: string): Promise<JWTPayload | undefined> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["HS256"],
      audience,
      clockTolerance: 0,
      requiredClaims: ["aud", "sub", "workspace", "action", "resource", "resource_version", "jti", "iat", "exp"],
    });
    if (payload.aud !== audience || payload.action !== "order:read") return undefined;
    if (typeof payload.sub !== "string" || !payload.sub) return undefined;
    if (typeof payload.workspace !== "string" || !payload.workspace) return undefined;
    if (typeof payload.resource !== "string" || !payload.resource) return undefined;
    if (typeof payload.resource_version !== "string" || !payload.resource_version) return undefined;
    if (typeof payload.jti !== "string" || !payload.jti) return undefined;
    if (typeof payload.iat !== "number" || typeof payload.exp !== "number") return undefined;
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return undefined;
    const lifetime = payload.exp - payload.iat;
    if (lifetime <= 0 || lifetime > 30) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

function jsonObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
  return parsed as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
  if (status !== 200 && encoded.includes(PRIVATE_STATUS)) {
    res.writeHead(500, headers);
    res.end(JSON.stringify({ error: "not_available" }));
    return;
  }
  res.writeHead(status, headers);
  res.end(encoded);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65_536) reject(new Error("too_large"));
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

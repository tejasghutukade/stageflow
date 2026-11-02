import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export type OidcProviderChecks = {
  issuer: string;
  audience: string;
  signature: "ES256";
  nonce: true;
  pkce: "S256";
};

export type LocalOidcProvider = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  name: string;
  accessToken(): string | null;
  checks(): OidcProviderChecks | null;
  refreshCalls(): number;
  setRefreshMode(mode: "ok" | "deny"): void;
  setRevocation(handler: ((subject: string) => { status: number; body: unknown }) | null): void;
  close(): Promise<void>;
};

export async function startLocalOidcProvider(options: {
  subject?: string;
  jwksUri?: string;
  corruptSignature?: boolean;
  name?: string;
  deny?: boolean;
  issueRefresh?: boolean;
  trackAccess?: boolean;
} = {}): Promise<LocalOidcProvider> {
  const clientId = "orders-app";
  const clientSecret = `secret-${randomBytes(16).toString("hex")}`;
  const subject = options.subject ?? "alice";
  const name = options.name ?? "local-oidc";
  const keys = await generateKeyPair("ES256");
  const signingKey = options.corruptSignature ? (await generateKeyPair("ES256")).privateKey : keys.privateKey;
  const publicJwk = { ...await exportJWK(keys.publicKey), kid: "oidc-key", alg: "ES256", use: "sig" };
  const codes = new Map<string, { challenge: string; nonce: string; redirect: string }>();
  const refreshTokens = new Map<string, string>();
  let issuer = "";
  let issuedAccess: string | null = null;
  let passed: OidcProviderChecks | null = null;
  let refreshCalls = 0;
  let refreshMode: "ok" | "deny" = "ok";
  let revocation: ((subject: string) => { status: number; body: unknown }) | null = null;
  const accessToken = () => options.trackAccess ? randomBytes(32).toString("base64url") : "idp-access-token-should-not-leak";
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", issuer);
      if (req.method === "GET" && url.pathname === "/.well-known/openid-configuration") {
        return send(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: options.jwksUri ?? `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["ES256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          ...(options.issueRefresh ? { grant_types_supported: ["authorization_code", "refresh_token"] } : {}),
        });
      }
      if (req.method === "GET" && url.pathname === "/jwks") return send(res, 200, { keys: [publicJwk] });
      if (req.method === "GET" && url.pathname === "/active") {
        if (!revocation) return send(res, 404, { error: "not_found" });
        const result = revocation(url.searchParams.get("subject") ?? "");
        return send(res, result.status, result.body);
      }
      if (req.method === "GET" && url.pathname === "/authorize") {
        const redirect = url.searchParams.get("redirect_uri") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const nonce = url.searchParams.get("nonce") ?? "";
        const redirectUrl = new URL(redirect);
        if (url.searchParams.get("response_type") !== "code" || url.searchParams.get("client_id") !== clientId
          || url.searchParams.get("code_challenge_method") !== "S256" || !url.searchParams.get("scope")?.split(" ").includes("openid")
          || redirectUrl.protocol !== "http:" || redirectUrl.hostname !== "127.0.0.1" || !redirectUrl.pathname.endsWith("/oidc/callback")
          || redirectUrl.search || redirectUrl.username || challenge.length < 16 || state.length < 16 || nonce.length < 16) {
          return send(res, 400, { error: "invalid_request" });
        }
        if (options.deny) {
          res.writeHead(302, { Location: `${redirect}?error=access_denied&state=${encodeURIComponent(state)}` });
          res.end();
          return;
        }
        const code = randomBytes(24).toString("base64url");
        codes.set(code, { challenge, nonce, redirect });
        res.writeHead(302, { Location: `${redirect}?code=${code}&state=${encodeURIComponent(state)}` });
        res.end();
        return;
      }
      if (req.method === "POST" && url.pathname === "/token") {
        const body = new URLSearchParams(await readBody(req));
        const secret = body.get("client_secret") ?? "";
        const secretOk = secret.length === clientSecret.length && timingSafeEqual(Buffer.from(secret), Buffer.from(clientSecret));
        if (body.get("grant_type") === "refresh_token") {
          refreshCalls += 1;
          const current = refreshTokens.get(body.get("refresh_token") ?? "");
          if (!options.issueRefresh || !secretOk || body.get("client_id") !== clientId || !current || refreshMode === "deny") {
            return send(res, 400, { error: "invalid_grant" });
          }
          issuedAccess = accessToken();
          return send(res, 200, { access_token: issuedAccess, token_type: "Bearer", expires_in: 3600, refresh_token: body.get("refresh_token") });
        }
        const code = body.get("code") ?? "";
        const pending = codes.get(code);
        codes.delete(code);
        const verifier = body.get("code_verifier") ?? "";
        if (!pending || !secretOk || body.get("client_id") !== clientId || body.get("grant_type") !== "authorization_code"
          || body.get("redirect_uri") !== pending.redirect || createHash("sha256").update(verifier).digest("base64url") !== pending.challenge) {
          return send(res, 400, { error: "invalid_grant" });
        }
        const now = Math.floor(Date.now() / 1000);
        const idToken = await new SignJWT({ nonce: pending.nonce })
          .setProtectedHeader({ alg: "ES256", kid: "oidc-key" })
          .setIssuer(issuer).setAudience(clientId).setSubject(subject).setIssuedAt(now).setExpirationTime(now + 300).sign(signingKey);
        issuedAccess = accessToken();
        passed = { issuer, audience: clientId, signature: "ES256", nonce: true, pkce: "S256" };
        const refresh = options.issueRefresh ? randomBytes(32).toString("base64url") : undefined;
        if (refresh) refreshTokens.set(refresh, subject);
        return send(res, 200, { access_token: issuedAccess, token_type: "Bearer", expires_in: options.trackAccess ? 3600 : 300, id_token: idToken, ...(refresh ? { refresh_token: refresh } : {}) });
      }
      send(res, 404, { error: "not_found" });
    } catch {
      if (!res.headersSent) send(res, 400, { error: "invalid_request" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  issuer = `http://127.0.0.1:${address.port}`;
  return {
    issuer, clientId, clientSecret, name,
    accessToken: () => issuedAccess,
    checks: () => passed ? { ...passed, issuer } : null,
    refreshCalls: () => refreshCalls,
    setRefreshMode: (mode) => { refreshMode = mode; },
    setRevocation: (handler) => { revocation = handler; },
    close: () => close(server),
  };
}

export async function startRequestSink(): Promise<{ url: string; hits(): number; close(): Promise<void> }> {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    res.writeHead(500);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { url: `http://127.0.0.1:${address.port}/jwks`, hits: () => hits, close: () => close(server) };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
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
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

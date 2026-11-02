import { decodeProtectedHeader } from "jose";
import * as client from "openid-client";
import { isLoopbackHostname, trustedEndpoint, trustedIssuer } from "./http.js";
import { ConsumerIdentityStore, type OidcConnection, type OidcSigningAlgorithm } from "./store.js";
import { ConsumerAccessError } from "./types.js";

const STATE_MS = 10 * 60 * 1000;
const SESSION_MS = 60 * 60 * 1000;
const RESPONSE_BYTES = 65_536;

export async function prepareOidcConnection(store: ConsumerIdentityStore, connectionId: string, allowLoopback = false): Promise<void> {
  try {
    const connection = store.oidcSetup(connectionId);
    if (connection.status !== "draft" && connection.status !== "validated") throw new ConsumerAccessError("identity.setup_required");
    await discovered(store, connection, allowLoopback);
    store.markOidcValidated(connectionId);
  } catch (error) {
    if (error instanceof ConsumerAccessError) throw error;
    throw new ConsumerAccessError("identity.setup_required");
  }
}

export async function startOidcSignIn(store: ConsumerIdentityStore, connectionId: string, agentId: string, allowLoopback = false): Promise<{ authorizationUrl: string; state: string }> {
  const connection = store.oidcConnection(connectionId);
  if (connection.agentId !== agentId) throw new ConsumerAccessError("identity.verification_required");
  try {
    const config = await discovered(store, connection, allowLoopback);
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const expiresAt = Date.now() + STATE_MS;
    store.beginOidc(state, connection.id, agentId, verifier, nonce, connection.redirectUri, expiresAt);
    const authorizationUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: connection.redirectUri,
      scope: "openid",
      code_challenge: await client.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
      response_mode: "query",
    });
    return { authorizationUrl: authorizationUrl.href, state };
  } catch (error) {
    if (error instanceof ConsumerAccessError) throw error;
    throw new ConsumerAccessError("identity.verification_required");
  }
}

export async function completeOidcSignIn(store: ConsumerIdentityStore, agentId: string, currentUrl: URL, allowLoopback = false): Promise<string> {
  try {
    if (![...currentUrl.searchParams.keys()].every((key) => key === "code" || key === "state" || key === "iss")) {
      throw new Error("unexpected");
    }
    const state = currentUrl.searchParams.get("state") ?? "";
    const code = currentUrl.searchParams.get("code") ?? "";
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(state) || code.length < 8 || code.length > 2048) throw new Error("invalid");
    const pending = store.consumeOidc(state);
    const redirect = new URL(currentUrl.href);
    redirect.search = "";
    redirect.hash = "";
    if (pending.agentId !== agentId || pending.redirect !== redirect.origin + redirect.pathname) throw new Error("mismatch");
    const connection = store.oidcConnection(pending.connectionId);
    if (connection.agentId !== agentId) throw new Error("mismatch");
    const issuer = currentUrl.searchParams.get("iss");
    if (issuer !== null && issuer !== connection.issuer) throw new Error("issuer");
    const tokens = await client.authorizationCodeGrant(await discovered(store, connection, allowLoopback), currentUrl, {
      pkceCodeVerifier: pending.verifier,
      expectedState: state,
      expectedNonce: pending.nonce,
      idTokenExpected: true,
    });
    const idToken = tokens.id_token;
    const claims = tokens.claims();
    if (!idToken || !claims || claims.aud !== connection.clientId || claims.iss !== connection.issuer
      || typeof claims.sub !== "string" || claims.sub.length < 1 || claims.sub.length > 512 || /\s/.test(claims.sub)) throw new Error("claims");
    const header = decodeProtectedHeader(idToken);
    if (!connection.algorithms.includes(header.alg as OidcSigningAlgorithm)) throw new Error("algorithm");
    const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined;
    const token = store.establishSession(connection.id, agentId, claims.sub, `oidc:${state}`, Date.now() + SESSION_MS);
    const authority = store.authenticate(token, agentId);
    if (refreshToken && refreshToken.length >= 8 && refreshToken.length <= 512 && !/\s/.test(refreshToken)) {
      store.saveRefreshSecret(authority.sessionId, refreshToken);
    }
    store.audit(authority.principal.id, null, "allow", "oidc_verified");
    return token;
  } catch (error) {
    if (error instanceof ConsumerAccessError) throw error;
    throw new ConsumerAccessError("identity.verification_required");
  }
}

export async function refreshOidcEvidence(store: ConsumerIdentityStore, sessionId: string, allowLoopback: boolean): Promise<boolean> {
  const material = store.refreshMaterial(sessionId);
  if (!material) return false;
  try {
    const protection = store.sessionProtection(sessionId);
    if (protection.kind !== "oidc") return false;
    const connection = store.oidcConnection(protection.connectionId);
    const issuer = trustedIssuer(connection.issuer, allowLoopback);
    const config = await discovered(store, connection, allowLoopback);
    const tokenEndpointValue = config.serverMetadata().token_endpoint;
    if (!tokenEndpointValue) return false;
    const tokenEndpoint = trustedEndpoint(tokenEndpointValue, allowLoopback);
    if (tokenEndpoint.origin !== issuer.origin) return false;
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: material.secret, client_id: connection.clientId, client_secret: store.oidcClientSecret(connection.id) }),
      redirect: "error",
      signal: AbortSignal.timeout(3_000),
    });
    const parsed = await readTokenResponse(response);
    if (!parsed) return false;
    const nextRefresh = typeof parsed.refresh_token === "string" ? parsed.refresh_token : undefined;
    if (nextRefresh && (nextRefresh.length < 8 || nextRefresh.length > 512 || /\s/.test(nextRefresh))) return false;
    if (nextRefresh) store.saveRefreshSecret(material.holderId, nextRefresh);
    const at = store.currentTime();
    store.touchEvidence(sessionId, at);
    if (material.holderId !== sessionId) store.touchEvidence(material.holderId, at);
    return true;
  } catch {
    return false;
  }
}

async function readTokenResponse(response: Response): Promise<{ access_token: string; refresh_token?: unknown } | null> {
  try {
    if (!response.ok || !response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { access_token?: unknown; refresh_token?: unknown };
    if (!parsed || typeof parsed !== "object" || typeof parsed.access_token !== "string" || parsed.access_token.length < 1) return null;
    return parsed as { access_token: string; refresh_token?: unknown };
  } catch {
    return null;
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

async function discovered(store: ConsumerIdentityStore, connection: OidcConnection, allowLoopback: boolean): Promise<client.Configuration> {
  const issuer = trustedIssuer(connection.issuer, allowLoopback);
  const config = await client.discovery(issuer, connection.clientId, {
    client_secret: store.oidcClientSecret(connection.id),
    [client.clockTolerance]: 0,
    ...(connection.algorithms.length === 1 ? { id_token_signed_response_alg: connection.algorithms[0] } : {}),
  }, undefined, {
    [client.customFetch]: boundedFetch(issuer),
    timeout: 3,
    ...(allowLoopback && issuer.protocol === "http:" ? { execute: [client.allowInsecureRequests] } : {}),
  });
  client.enableNonRepudiationChecks(config);
  const metadata = config.serverMetadata();
  if (metadata.issuer !== connection.issuer || !metadata.authorization_endpoint || !metadata.token_endpoint || !metadata.jwks_uri) {
    throw new Error("metadata");
  }
  for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri, metadata.userinfo_endpoint]) {
    if (!endpoint) continue;
    const url = trustedEndpoint(endpoint, allowLoopback);
    if (url.origin !== issuer.origin) throw new Error("off_origin");
  }
  return config;
}

function boundedFetch(issuer: URL): client.CustomFetch {
  return async (url, options) => {
    const target = new URL(url);
    if (target.origin !== issuer.origin || target.username || target.password) throw new Error("off_origin");
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(3_000)]) : AbortSignal.timeout(3_000);
    const response = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body as BodyInit | undefined,
      redirect: "error",
      signal,
    });
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("response_too_large");
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    let bytes = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const part = await reader.read();
        if (part.done) {
          controller.close();
          return;
        }
        bytes += part.value.byteLength;
        if (bytes > RESPONSE_BYTES) {
          await reader.cancel();
          controller.error(new Error("response_too_large"));
          return;
        }
        controller.enqueue(part.value);
      },
    });
    return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export function loopbackRequestUrl(hostHeader: string | undefined, rawUrl: string, allowLoopback: boolean): URL {
  if (!hostHeader || hostHeader !== hostHeader.trim() || /[\s@/\\]/.test(hostHeader)) throw new ConsumerAccessError("identity.verification_required");
  let hostname = "";
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    throw new ConsumerAccessError("identity.verification_required");
  }
  const loopback = allowLoopback && isLoopbackHostname(hostname);
  try {
    const url = new URL(rawUrl, `${loopback ? "http:" : "https:"}//${hostHeader}`);
    if (url.username || url.password || url.origin !== `${loopback ? "http:" : "https:"}//${hostHeader}`) {
      throw new Error("origin");
    }
    return url;
  } catch (error) {
    if (error instanceof ConsumerAccessError) throw error;
    throw new ConsumerAccessError("identity.verification_required");
  }
}

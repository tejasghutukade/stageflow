import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";

export type AllowedHostEntry = {
  hostname: string;
  port?: string;
};

export type AllowedHosts = {
  entries: AllowedHostEntry[];
};

function writeForbidden(
  res: ServerResponse,
  body: Record<string, string>,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(403, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function hostnameFromHostHeader(hostHeader: string): string {
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader : hostHeader.slice(1, end);
  }
  const colon = hostHeader.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(hostHeader.slice(colon + 1))) {
    return hostHeader.slice(0, colon);
  }
  return hostHeader;
}

export function portFromHostHeader(hostHeader: string): string | undefined {
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    if (end === -1) return undefined;
    const rest = hostHeader.slice(end + 1);
    if (rest.startsWith(":") && /^\d+$/.test(rest.slice(1))) {
      return rest.slice(1);
    }
    return undefined;
  }
  const colon = hostHeader.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(hostHeader.slice(colon + 1))) {
    return hostHeader.slice(colon + 1);
  }
  return undefined;
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  if (isIP(h) === 4) {
    const first = Number(h.split(".")[0]);
    return first === 127;
  }
  return false;
}

export function isLoopbackRemoteAddress(addr: string | undefined): boolean {
  if (addr === undefined || addr.length === 0) return false;
  let normalized = addr;
  if (normalized.toLowerCase().startsWith("::ffff:")) {
    normalized = normalized.slice(7);
  }
  if (normalized === "::1") return true;
  if (isIP(normalized) === 4) {
    const first = Number(normalized.split(".")[0]);
    return first === 127;
  }
  return false;
}

/** Loopback peer plus Host (and Origin, when present) — trusted local plane for ensure. */
export function isTrustedLocalHttpRequest(req: IncomingMessage): boolean {
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== "string" || hostHeader.length === 0) return false;
  if (!isLoopbackHostname(hostnameFromHostHeader(hostHeader))) return false;
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    try {
      const originUrl = new URL(origin);
      if (!isLoopbackHostname(originUrl.hostname)) return false;
    } catch {
      return false;
    }
  }
  return isLoopbackRemoteAddress(req.socket?.remoteAddress);
}

export function resolveAllowedHosts(
  env: NodeJS.ProcessEnv = process.env,
): AllowedHosts {
  const raw = env.STAGEFLOW_ALLOWED_HOSTS;
  const entries: AllowedHostEntry[] = [
    { hostname: "localhost" },
    { hostname: "127.0.0.1" },
    { hostname: "::1" },
  ];
  if (raw === undefined || raw.trim() === "") {
    return { entries };
  }
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token.length === 0) continue;
    if (token === "*") {
      throw new Error(
        "STAGEFLOW_ALLOWED_HOSTS must not contain '*'; list explicit hostnames instead.",
      );
    }
    const parsed = parseAllowedHostEntry(token);
    if (
      !entries.some(
        (e) =>
          e.hostname === parsed.hostname &&
          (e.port ?? "") === (parsed.port ?? ""),
      )
    ) {
      entries.push(parsed);
    }
  }
  return { entries };
}

function parseAllowedHostEntry(token: string): AllowedHostEntry {
  if (token.startsWith("[")) {
    const end = token.indexOf("]");
    if (end === -1) {
      throw new Error(`Invalid STAGEFLOW_ALLOWED_HOSTS entry: ${token}`);
    }
    const hostname = token.slice(1, end).toLowerCase();
    const rest = token.slice(end + 1);
    if (rest.length === 0) return { hostname };
    if (rest.startsWith(":") && /^\d+$/.test(rest.slice(1))) {
      return { hostname, port: rest.slice(1) };
    }
    throw new Error(`Invalid STAGEFLOW_ALLOWED_HOSTS entry: ${token}`);
  }
  const colon = token.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(token.slice(colon + 1))) {
    return {
      hostname: token.slice(0, colon).toLowerCase(),
      port: token.slice(colon + 1),
    };
  }
  return { hostname: token.toLowerCase() };
}

/**
 * Adds the Host's own listen address (that exact IP and port) to the allowed hosts. A Host bound to one
 * non-loopback address (a private address behind a platform's gateway) calls itself there, for example the
 * eval engine's callback, and would otherwise refuse its own requests as a forbidden host. A literal IP
 * cannot be reached through DNS rebinding, which the host check guards against. A wildcard or loopback
 * bind adds nothing (loopback is always allowed).
 */
export function allowListenAddress(allowed: AllowedHosts, bind: string, port: number): void {
  const hostname = bind.replace(/^\[|\]$/g, "").toLowerCase();
  if (isIP(hostname) === 0 || hostname === "0.0.0.0" || hostname === "::" || isLoopbackHostname(hostname)) return;
  const entry = { hostname, port: String(port) };
  if (allowed.entries.some((e) => e.hostname === entry.hostname && e.port === entry.port)) return;
  allowed.entries.push(entry);
}

export function isHostAllowed(
  allowed: AllowedHosts,
  hostname: string,
  port?: string,
): boolean {
  const h = hostname.toLowerCase();
  if (isLoopbackHostname(h)) return true;
  for (const entry of allowed.entries) {
    if (entry.hostname !== h) continue;
    if (entry.port === undefined) return true;
    if (port !== undefined && entry.port === port) return true;
  }
  return false;
}

function defaultPortForProtocol(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

/**
 * An Origin is allowed only when its host and port equal the Host header.
 * A missing port is 80 for http and 443 for https. A loopback page on another
 * port does not match.
 */
export function originMatchesHostHeader(origin: string, hostHeader: string): boolean {
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") return false;
  const originName = originUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const headerName = hostnameFromHostHeader(hostHeader).toLowerCase();
  if (originName !== headerName) return false;
  const schemePort = defaultPortForProtocol(originUrl.protocol);
  const originPort = originUrl.port || schemePort;
  const headerPort = portFromHostHeader(hostHeader) ?? schemePort;
  return originPort === headerPort;
}

export function isPublicChatApiPath(pathname: string): boolean {
  return pathname.startsWith("/api/public/chat/");
}

export function assertAllowedHttpAccess(
  allowed: AllowedHosts,
  req: IncomingMessage,
  res: ServerResponse,
  options: { requireOrigin?: boolean; skipOriginHostMatch?: boolean } = {},
): boolean {
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== "string" || hostHeader.length === 0) {
    writeForbidden(res, { error: "Forbidden host" });
    return false;
  }
  const hostname = hostnameFromHostHeader(hostHeader);
  const port = portFromHostHeader(hostHeader);
  if (!isHostAllowed(allowed, hostname, port)) {
    writeForbidden(res, { error: "Forbidden host", host: hostname });
    return false;
  }

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    if (
      !options.skipOriginHostMatch &&
      !originMatchesHostHeader(origin, hostHeader)
    ) {
      let originHost: string | undefined;
      try {
        originHost = new URL(origin).hostname;
      } catch {
        originHost = undefined;
      }
      writeForbidden(
        res,
        originHost !== undefined && originHost.length > 0
          ? { error: "Forbidden origin", host: originHost }
          : { error: "Forbidden origin" },
      );
      return false;
    }
  } else if (options.requireOrigin) {
    writeForbidden(res, { error: "Origin required" });
    return false;
  }
  return true;
}

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

export function assertAllowedHttpAccess(
  allowed: AllowedHosts,
  req: IncomingMessage,
  res: ServerResponse,
  options: { requireOrigin?: boolean } = {},
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
    try {
      const originUrl = new URL(origin);
      const originHost = originUrl.hostname;
      const originPort = originUrl.port || undefined;
      if (!isHostAllowed(allowed, originHost, originPort)) {
        writeForbidden(res, { error: "Forbidden origin", host: originHost });
        return false;
      }
    } catch {
      writeForbidden(res, { error: "Forbidden origin" });
      return false;
    }
  } else if (options.requireOrigin) {
    writeForbidden(res, { error: "Origin required" });
    return false;
  }
  return true;
}

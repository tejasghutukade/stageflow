import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isLoopbackHostname, type AllowedHosts } from "./allowedHosts.js";
import { advertisedHost } from "./listenHost.js";

export const SANDBOX_PORT_MIN = 1024;
export const SANDBOX_PORT_MAX = 65535;
export const SANDBOX_PORT_SCAN = 20;
export const SANDBOX_MAX_CONNECTIONS = 64;
export const SANDBOX_MAX_HEADER_BYTES = 8 * 1024;
export const SANDBOX_KEEPALIVE_MS = 1000;

export const SHELL_PERMISSIONS_POLICY =
  "camera=(), microphone=(), geolocation=(), clipboard-read=(), usb=(), serial=(), payment=()";

export type SandboxDisableReason =
  | "disabled"
  | "remote-bind"
  | "invalid-port"
  | "pinned-taken"
  | "no-port"
  | "ipv6-console"
  | "listen-failed"
  | "listening";

export function sandboxDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
  return env.STAGEFLOW_SANDBOX_DISABLED === "1";
}

export function readSandboxPort(env: NodeJS.ProcessEnv): number | undefined | "invalid" {
  const raw = env.STAGEFLOW_SANDBOX_PORT;
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!/^\d+$/.test(raw.trim())) return "invalid";
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < SANDBOX_PORT_MIN || port > SANDBOX_PORT_MAX) return "invalid";
  return port;
}

export function sandboxAllowedForListen(listenHost: string, env: NodeJS.ProcessEnv): boolean {
  if (sandboxDisabledByEnv(env)) return false;
  if (readSandboxPort(env) !== undefined) return readSandboxPort(env) !== "invalid";
  if (env.STAGEFLOW_IN_DOCKER === "1") return false;
  return loopbackListen(listenHost);
}

export function loopbackListen(listenHost: string): boolean {
  const host = listenHost.trim().toLowerCase();
  if (host === "0.0.0.0" || host === "::" || host === "") return false;
  return isLoopbackHostname(host);
}

export function consoleHostIsIpv6(listenHost: string): boolean {
  return isIP(unwrapHost(advertisedHost(listenHost))) === 6;
}

function unwrapHost(host: string): string {
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

/**
 * Cookie jars ignore ports. The sandbox hostname is the other loopback name from the
 * console's advertised host: 127.0.0.1 <-> localhost. The listener binds 127.0.0.1 and
 * ::1 when that socket exists, so both names answer. An IPv6 console hostname is not
 * a sandbox parent: Chrome rejects an IPv6 literal in frame-ancestors.
 */
export function sandboxHostname(listenHost: string): { hostname: "localhost" | "127.0.0.1"; bindV6: boolean } {
  const advertised = unwrapHost(advertisedHost(listenHost)).toLowerCase();
  if (advertised === "127.0.0.1") return { hostname: "localhost", bindV6: true };
  return { hostname: "127.0.0.1", bindV6: true };
}

export function sandboxOriginPair(port: number): string[] {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

export function parseSandboxOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1") return null;
  if (!url.port) return null;
  return `http://${host}:${url.port}`;
}

export function consoleOriginsFor(input: {
  listenHost: string;
  port: number;
  allowedHosts: AllowedHosts;
  publicUrl?: string | null;
}): string[] {
  const origins: string[] = [];
  const push = (value: string | null) => {
    if (value && !origins.includes(value)) origins.push(value);
  };
  push(originFromHost(advertisedHost(input.listenHost), input.port));
  if (loopbackListen(input.listenHost) || input.listenHost === "0.0.0.0" || input.listenHost === "::") {
    push(originFromHost("127.0.0.1", input.port));
    push(originFromHost("localhost", input.port));
  }
  if (input.publicUrl) push(normalizeOrigin(input.publicUrl));
  for (const entry of input.allowedHosts.entries) {
    if (isLoopbackHostname(entry.hostname)) continue;
    const scheme = input.publicUrl && originHost(input.publicUrl) === entry.hostname ? "https" : "http";
    const port = entry.port ?? String(input.port);
    push(normalizeOrigin(`${scheme}://${formatHost(entry.hostname)}:${port}`));
  }
  return origins;
}

export function frameAncestorOrigins(consoleOrigins: readonly string[]): string[] {
  const origins: string[] = [];
  for (const origin of consoleOrigins) {
    if (!origin || isIpv6Origin(origin) || origins.includes(origin)) continue;
    origins.push(origin);
  }
  return origins;
}

export function shellContentSecurityPolicy(consoleOrigins: readonly string[]): string {
  const listed = frameAncestorOrigins(consoleOrigins);
  const ancestors = listed.length > 0 ? listed.join(" ") : "'none'";
  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline' https:",
    "style-src 'unsafe-inline' https:",
    "img-src data: https:",
    "font-src data: https:",
    "media-src data: https:",
    "connect-src https:",
    "frame-src about:",
    "base-uri https:",
    "form-action 'none'",
    "object-src 'none'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
}

export function shellDocumentHeaders(consoleOrigins: readonly string[]): Record<string, string> {
  return {
    "Content-Security-Policy": shellContentSecurityPolicy(consoleOrigins),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Permissions-Policy": SHELL_PERMISSIONS_POLICY,
    "Cross-Origin-Opener-Policy": "same-origin",
  };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function originFromHost(host: string, port: number): string | null {
  return normalizeOrigin(`http://${host}:${port}`);
}

function formatHost(hostname: string): string {
  return isIP(hostname) === 6 ? `[${hostname}]` : hostname;
}

function isIpv6Origin(value: string): boolean {
  try {
    return isIP(unwrapHost(new URL(value).hostname)) === 6;
  } catch {
    return false;
  }
}

function originHost(value: string): string | null {
  const origin = normalizeOrigin(value);
  if (!origin) return null;
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function normalizeOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  const port = url.port;
  const host = url.hostname.toLowerCase();
  const formatted = isIP(host) === 6 ? `[${host}]` : host;
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const shown = port && port !== defaultPort ? `:${port}` : "";
  return `${url.protocol}//${formatted}${shown}`;
}

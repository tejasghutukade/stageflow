import { useEffect, useSyncExternalStore } from "react";
import { api } from "./api/client";

export type HostInfo = {
  hosted: boolean;
  managed: boolean;
  publicUrl: string | null;
  publicChatUrl: string | null;
};

/** `sandbox_origin` from `GET /api/health`. A non-empty string is the shell origin. Null, absent, and non-strings mean the listener is off. */
export function parseSandboxOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > 200 || /\s/.test(value)) return null;
  return value;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

function strictSandboxOrigin(value: string): string | null {
  if (value.length === 0 || value.length > 200 || /\s/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  const hostname = url.hostname.toLowerCase();
  if (!LOOPBACK_HOSTS.has(hostname)) return null;
  if (url.port === "") return null;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `http://${hostname}:${port}`;
}

function isIpv6Hostname(hostname: string): boolean {
  const bare = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return bare.includes(":");
}

/**
 * Pick the shell origin whose hostname is not the page's.
 * A console on `localhost` uses `http://127.0.0.1:<port>`; a console on `127.0.0.1` uses `http://localhost:<port>`.
 * Invalid entries are ignored. An empty list, or a list with no differing host, falls back to `sandboxOrigin`.
 * An IPv6 page hostname returns null.
 */
export function chooseSandboxOrigin(sandboxOrigin: unknown, sandboxOrigins: unknown, locationHostname: string): string | null {
  if (isIpv6Hostname(locationHostname)) return null;
  const pageHost = locationHostname.trim().toLowerCase().replace(/\.$/, "");
  const list = Array.isArray(sandboxOrigins) ? sandboxOrigins : [];
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const origin = strictSandboxOrigin(entry);
    if (!origin) continue;
    if (new URL(origin).hostname !== pageHost) return origin;
  }
  return typeof sandboxOrigin === "string" ? strictSandboxOrigin(sandboxOrigin) : null;
}

const EMPTY: HostInfo = { hosted: false, managed: false, publicUrl: null, publicChatUrl: null };

let current: HostInfo = EMPTY;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: HostInfo): void {
  current = next;
  for (const listener of listeners) listener();
}

function load(): void {
  if (loading) return;
  loading = api<HostInfo>("/api/host-info")
    .then((info) => publish({ ...EMPTY, ...info }))
    .catch(() => {
      loading = null;
    });
}

export function getHostInfo(): HostInfo {
  return current;
}

export function setHostInfoForTests(info: HostInfo | null): void {
  loading = info ? Promise.resolve() : null;
  publish(info ?? EMPTY);
}

/** What the Host says its public addresses are. Until it answers, the browser's own address is what the console shows. */
export function useHostInfo(): HostInfo {
  useEffect(load, []);
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getHostInfo,
    getHostInfo,
  );
}

/** Origin for the console, API and MCP. */
export function consoleOrigin(info: HostInfo, browserOrigin: string): string {
  return info.publicUrl ?? browserOrigin;
}

/** Origin for public web chat pages and their sign-in callbacks. */
export function chatOrigin(info: HostInfo, browserOrigin: string): string {
  return info.publicChatUrl ?? info.publicUrl ?? browserOrigin;
}

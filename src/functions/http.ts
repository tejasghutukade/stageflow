import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP, type Socket } from "node:net";
import { Agent, fetch as undiciFetch, type Dispatcher } from "undici";
import { isForeverDeniedSecret } from "../runtime/stageEnvironment.js";
import { FUNCTION_HTTP_REDIRECTS_MAX, FUNCTION_IO_BYTES_MAX, type JsonValue } from "./protocol.js";

export type FunctionApiGrant = {
  origin: string;
  methods: readonly string[];
  pathPrefix: string;
  access: "read" | "action";
  credential?: string;
};

export type FunctionLookup = (hostname: string) => Promise<readonly string[]>;

export type FunctionDial = (address: string, port: number, servername: string) => Promise<Socket>;

export type HttpCapabilityResult =
  | { ok: true; value: JsonValue }
  | { ok: false; code: string; message: string };

const API_DENIED = { ok: false as const, code: "permission_denied", message: "api access denied" };
const CANCELLED = { ok: false as const, code: "cancelled", message: "function execution cancelled" };
const BODY_LIMIT = { ok: false as const, code: "file_limit", message: "response exceeds 1 MiB" };
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

const BLOCKED = new BlockList();
BLOCKED.addSubnet("0.0.0.0", 8, "ipv4");
BLOCKED.addSubnet("10.0.0.0", 8, "ipv4");
BLOCKED.addSubnet("100.64.0.0", 10, "ipv4");
BLOCKED.addSubnet("127.0.0.0", 8, "ipv4");
BLOCKED.addSubnet("169.254.0.0", 16, "ipv4");
BLOCKED.addSubnet("172.16.0.0", 12, "ipv4");
BLOCKED.addSubnet("192.168.0.0", 16, "ipv4");
BLOCKED.addSubnet("224.0.0.0", 4, "ipv4");
BLOCKED.addSubnet("::", 128, "ipv6");
BLOCKED.addSubnet("::1", 128, "ipv6");
BLOCKED.addSubnet("fc00::", 7, "ipv6");
BLOCKED.addSubnet("fe80::", 10, "ipv6");
BLOCKED.addSubnet("ff00::", 8, "ipv6");

export async function performFunctionHttp(input: {
  method: string | undefined;
  origin: string | undefined;
  requestPath: string | undefined;
  body?: string;
  grants: readonly FunctionApiGrant[];
  resolveCredential: (name: string) => string | undefined;
  lookup?: FunctionLookup;
  dial?: FunctionDial;
  signal: AbortSignal;
}): Promise<HttpCapabilityResult> {
  if (input.signal.aborted) return CANCELLED;
  const method = input.method?.toUpperCase();
  if (!method || !METHODS.has(method)) return API_DENIED;
  if (!input.requestPath || !pathAllowed(input.requestPath, input.requestPath)) return API_DENIED;
  let current: URL;
  try {
    current = new URL(input.requestPath, input.origin);
  } catch {
    return API_DENIED;
  }
  const grant = matchGrant(input.grants, method, current);
  if (!grant) return API_DENIED;
  let authorization: string | undefined;
  if (grant.credential) {
    if (isForeverDeniedSecret(grant.credential)) return API_DENIED;
    const secret = input.resolveCredential(grant.credential);
    if (!secret) return { ok: false, code: "missing_binding", message: "required credential is missing" };
    authorization = `Bearer ${secret}`;
  }
  if (input.body !== undefined && Buffer.byteLength(input.body, "utf8") > FUNCTION_IO_BYTES_MAX) return BODY_LIMIT;
  const lookup = input.lookup ?? defaultLookup;
  let verb = method;
  let body = verb === "GET" || verb === "HEAD" ? undefined : input.body;
  let allowOtherHost = false;
  for (let hop = 0; hop <= FUNCTION_HTTP_REDIRECTS_MAX; hop += 1) {
    if (input.signal.aborted) return CANCELLED;
    if (!grantMatches(grant, current, verb, allowOtherHost)) return API_DENIED;
    const pinned = await resolvePinnedAddress(current.hostname, lookup);
    if (!pinned) return API_DENIED;
    const outcome = await requestOnce({
      url: current,
      pinned,
      method: verb,
      body,
      authorization,
      signal: input.signal,
      dial: input.dial,
    });
    if (outcome.status === "aborted") return CANCELLED;
    if (outcome.status === "denied") return API_DENIED;
    if (outcome.status === "redirect") {
      if (hop === FUNCTION_HTTP_REDIRECTS_MAX) return API_DENIED;
      if (outcome.next.host !== current.host) authorization = undefined;
      if (outcome.code === 301 || outcome.code === 302 || outcome.code === 303) {
        verb = "GET";
        body = undefined;
      }
      current = outcome.next;
      allowOtherHost = true;
      continue;
    }
    return outcome.result;
  }
  return API_DENIED;
}

function isPublicAddress(address: string): boolean {
  const parsed = canonicalAddress(address);
  if (!parsed) return false;
  return !BLOCKED.check(parsed.address, parsed.family);
}

async function resolvePinnedAddress(hostname: string, lookup: FunctionLookup): Promise<string | undefined> {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (isMetadataHostname(host)) return undefined;
  if (isIP(host) !== 0 && !isPublicAddress(host)) return undefined;
  let first: readonly string[];
  let second: readonly string[];
  try {
    first = await lookup(host);
    if (first.some((address) => !isPublicAddress(address))) return undefined;
    second = await lookup(host);
  } catch {
    return undefined;
  }
  if (second.length === 0 || second.some((address) => !isPublicAddress(address))) return undefined;
  return first.find((address) => second.includes(address) && isPublicAddress(address));
}

type HopResult =
  | { status: "redirect"; code: number; next: URL }
  | { status: "done"; result: HttpCapabilityResult }
  | { status: "aborted" }
  | { status: "denied" };

async function requestOnce(input: {
  url: URL;
  pinned: string;
  method: string;
  body: string | undefined;
  authorization: string | undefined;
  signal: AbortSignal;
  dial?: FunctionDial;
}): Promise<HopResult> {
  const dispatcher = dispatcherFor(input.pinned, input.url.hostname, input.dial);
  try {
    const response = await undiciFetch(input.url, {
      method: input.method,
      dispatcher,
      redirect: "manual",
      signal: input.signal,
      headers: input.authorization ? { authorization: input.authorization } : undefined,
      body: input.body,
    });
    if (input.signal.aborted) return { status: "aborted" };
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) return { status: "denied" };
      try {
        return { status: "redirect", code: response.status, next: new URL(location, input.url) };
      } catch {
        return { status: "denied" };
      }
    }
    return { status: "done", result: await readResponse(response, input.signal) };
  } catch {
    return input.signal.aborted ? { status: "aborted" } : { status: "denied" };
  } finally {
    await dispatcher.close().catch(() => undefined);
  }
}

function dispatcherFor(pinned: string, servername: string, dial: FunctionDial | undefined): Dispatcher {
  if (!dial) {
    return new Agent({
      connect: {
        lookup: pinLookup(pinned),
        servername,
      },
    });
  }
  return new Agent({
    connect: (options, callback) => {
      const port = Number(options.port) || (options.protocol === "https:" ? 443 : 80);
      dial(pinned, port, options.servername || servername)
        .then((socket) => callback(null, socket))
        .catch((error: Error) => callback(error, null));
    },
  });
}

function pinLookup(pinned: string) {
  const family = isIP(pinned) === 6 ? 6 : 4;
  return (hostname: string, options: unknown, callback?: LookupCallback) => {
    const cb = typeof options === "function" ? (options as LookupCallback) : callback;
    if (!cb) return;
    const all =
      typeof options === "object" &&
      options !== null &&
      "all" in options &&
      (options as { all?: boolean }).all === true;
    if (all) cb(null, [{ address: pinned, family }]);
    else cb(null, pinned, family);
  };
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

async function readResponse(
  response: Awaited<ReturnType<typeof undiciFetch>>,
  signal: AbortSignal,
): Promise<HttpCapabilityResult> {
  const reader = response.body?.getReader();
  if (!reader) return { ok: true, value: { status: response.status, body: "" } };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) return CANCELLED;
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > FUNCTION_IO_BYTES_MAX) {
        await reader.cancel().catch(() => undefined);
        return BODY_LIMIT;
      }
      chunks.push(part.value);
    }
  } catch {
    if (signal.aborted) return CANCELLED;
    return API_DENIED;
  }
  if (signal.aborted) return CANCELLED;
  return {
    ok: true,
    value: { status: response.status, body: Buffer.concat(chunks).toString("utf8") },
  };
}

function matchGrant(grants: readonly FunctionApiGrant[], method: string, url: URL): FunctionApiGrant | undefined {
  return grants.find((grant) => grantMatches(grant, url, method, false));
}

export function functionApiIsAction(
  grants: readonly FunctionApiGrant[],
  method: string | undefined,
  origin: string | undefined,
  requestPath: string | undefined,
): boolean {
  const verb = method?.toUpperCase();
  if (!verb || !METHODS.has(verb) || !origin || !requestPath) return false;
  let current: URL;
  try {
    current = new URL(requestPath, origin);
  } catch {
    return false;
  }
  return matchGrant(grants, verb, current)?.access === "action";
}

function grantMatches(grant: FunctionApiGrant, url: URL, method: string, allowOtherHost: boolean): boolean {
  let origin: URL;
  try {
    origin = new URL(grant.origin);
  } catch {
    return false;
  }
  if (origin.protocol !== "https:" || origin.username || origin.password) return false;
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (isMetadataHostname(url.hostname) || isMetadataHostname(origin.hostname)) return false;
  if (!grant.methods.some((item) => item.toUpperCase() === method)) return false;
  if (!pathAllowed(grant.pathPrefix, url.pathname)) return false;
  if (url.origin === origin.origin) return true;
  return allowOtherHost && hopAllowed(url);
}

function hopAllowed(url: URL): boolean {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (isMetadataHostname(url.hostname)) return false;
  if (isIP(url.hostname) !== 0 && !isPublicAddress(url.hostname)) return false;
  return true;
}

function pathAllowed(prefix: string, requestPath: string): boolean {
  if (!prefix.startsWith("/") || !requestPath.startsWith("/") || requestPath.startsWith("//")) return false;
  if (requestPath.includes("\\") || requestPath.includes("\0") || requestPath.includes("://")) return false;
  let normalized = pathPosix(requestPath);
  if (!normalized.startsWith("/") || normalized.split("/").includes("..")) return false;
  if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  const clean = prefix.length > 1 && prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  if (pathPosix(clean) !== clean && prefix !== "/") return false;
  return normalized === clean || normalized.startsWith(`${clean}/`);
}

function pathPosix(filePath: string): string {
  const parts: string[] = [];
  for (const part of filePath.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return "/../";
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function isMetadataHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  return (
    host === "metadata" ||
    host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal") ||
    host === "metadata.internal" ||
    host.endsWith(".metadata.internal")
  );
}

function canonicalAddress(address: string): { address: string; family: "ipv4" | "ipv6" } | undefined {
  if (isIP(address) === 4) return { address, family: "ipv4" };
  if (isIP(address) !== 6) return undefined;
  const lower = address.toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted?.[1] && isIP(dotted[1]) === 4) return { address: dotted[1], family: "ipv4" };
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    return { address: `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, family: "ipv4" };
  }
  return { address: lower, family: "ipv6" };
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

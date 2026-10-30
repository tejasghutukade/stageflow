export async function boundedJson(url: URL, body: unknown, headers: Record<string, string>, signal: AbortSignal,
  fetcher: typeof fetch = fetch): Promise<unknown> {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(3_000)]);
  const response = await fetcher(url, {
    method: "POST", redirect: "error", signal: boundedSignal,
    headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  try {
    if (!response.ok || !response.body) throw new Error("request_failed");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 65_536) {
        await reader.cancel();
        throw new Error("response_too_large");
      }
      chunks.push(part.value);
    }
    return parseBoundedJson(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

export async function boundedGet(url: URL, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<unknown> {
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(3_000)]);
  const response = await fetcher(url, { method: "GET", redirect: "error", signal: boundedSignal });
  try {
    if (!response.ok || !response.body) throw new Error("request_failed");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > 65_536) {
        await reader.cancel();
        throw new Error("response_too_large");
      }
      chunks.push(part.value);
    }
    return parseBoundedJson(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

function parseBoundedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("request_failed");
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

export function trustedEndpoint(value: string, allowLoopback: boolean): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:"
    && !(allowLoopback && url.protocol === "http:" && isLoopbackHostname(url.hostname)))) {
    throw new Error("A trusted HTTPS endpoint is required");
  }
  return url;
}

/** Issuer identifiers have no path, query, or userinfo. Discovery never becomes a general private-network fetch. */
export function trustedIssuer(value: string, allowLoopback: boolean): URL {
  const url = trustedEndpoint(value, allowLoopback);
  if ((url.pathname !== "/" && url.pathname !== "") || isBlockedHostname(url.hostname, allowLoopback)) {
    throw new Error("A trusted HTTPS endpoint is required");
  }
  return url;
}

function isBlockedHostname(hostname: string, allowLoopback: boolean): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "metadata.google.internal" || host.endsWith(".metadata.google.internal")) return true;
  if (host.startsWith("::ffff:")) return isBlockedHostname(host.slice("::ffff:".length), allowLoopback);
  if (isLoopbackHostname(host) || isLoopbackHostname(hostname)) return !allowLoopback;
  if (/^\d+$/.test(host) || host.includes("%")) return true;
  if (host.includes(":") && (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd") || host === "::" || host === "0:0:0:0:0:0:0:0")) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const octets = v4.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  const [a, b] = octets;
  if (a === 127) return !allowLoopback;
  return a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

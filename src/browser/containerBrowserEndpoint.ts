export interface BrowserEndpointClient {
  /** The browser-level debugging address behind an `http(s)://ip:port` endpoint, or undefined while nothing answers. */
  resolve(endpoint: string): Promise<string | undefined>;
  /** Asks the browser to close itself over the debugging protocol (this flushes the profile); resolves once it hung up or the bound passed. */
  closeBrowser(cdpAddress: string, timeoutMs: number): Promise<void>;
}

const PROBE_TIMEOUT_MS = 2_000;

export function endpointOf(cdpAddress: string): string {
  const url = new URL(cdpAddress);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return `${url.protocol}//${url.host}`;
}

export function createCdpEndpointClient(
  options: { WebSocketImpl?: typeof WebSocket; fetchImpl?: typeof fetch } = {},
): BrowserEndpointClient {
  const doFetch = options.fetchImpl ?? globalThis.fetch;

  return {
    async resolve(endpoint) {
      const base = endpoint.startsWith("ws") ? endpointOf(endpoint) : endpoint.replace(/\/+$/, "");
      try {
        const res = await doFetch(`${base}/json/version`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
        if (!res.ok) return undefined;
        const body = (await res.json()) as { webSocketDebuggerUrl?: unknown };
        if (typeof body.webSocketDebuggerUrl !== "string") return undefined;
        const advertised = new URL(body.webSocketDebuggerUrl);
        const origin = new URL(base);
        advertised.protocol = origin.protocol === "https:" ? "wss:" : "ws:";
        advertised.host = origin.host;
        return advertised.toString();
      } catch {
        return undefined;
      }
    },

    closeBrowser(cdpAddress, timeoutMs) {
      const Impl = options.WebSocketImpl ?? globalThis.WebSocket;
      return new Promise<void>((resolve) => {
        let ws: WebSocket;
        try {
          ws = new Impl(cdpAddress);
        } catch {
          resolve();
          return;
        }
        const timer = setTimeout(done, timeoutMs);
        function done() {
          clearTimeout(timer);
          try {
            ws.close();
          } catch {
            // already closed
          }
          resolve();
        }
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
        ws.onclose = done;
        ws.onerror = done;
      });
    },
  };
}

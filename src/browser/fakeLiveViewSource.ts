import type { LiveViewAddress, LiveViewSource } from "./liveViewSource.js";

export function createFakeLiveViewSource(
  options: { embedOrigin?: string; ttlMs?: number; now?: () => number } = {},
): LiveViewSource {
  const embedOrigin = options.embedOrigin ?? "https://viewer.example";
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;
  let counter = 0;
  return {
    async viewerAddress(request): Promise<LiveViewAddress> {
      counter += 1;
      return {
        url: `${embedOrigin}/view/${encodeURIComponent(request.sandboxId)}?t=${counter}`,
        embedOrigin,
        expiresAt: now() + ttlMs,
      };
    },
  };
}

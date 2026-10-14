import { ChannelError, type ChannelErrorCode } from "./errors.js";
import { ChannelHealthMonitor, type ChannelHealthOptions } from "./health.js";
import { channelHostFor, releaseChannelHost } from "./host.js";
import type { ConnectionHealth, ConnectionSummary } from "./types.js";

export type ChannelListing = {
  connections: Array<ConnectionSummary & { health?: ConnectionHealth }>;
  /** Set when `connections.yaml` could not be loaded. The file's content is never included. */
  error?: ChannelErrorCode;
};

export type ChannelService = {
  list(): ChannelListing;
  /** Runs one live check now. Returns undefined when the connection is unknown or disabled. */
  checkNow(id: string): Promise<ConnectionHealth | undefined>;
  stop(): Promise<void>;
};

/**
 * Host-side read model for the Connections page. A `connections.yaml` that fails to load does
 * not stop the host: the listing reports the error code and stages that use channels fail on
 * their own, while every other stage is unaffected.
 */
export function startChannelService(cwd: string, options: Pick<ChannelHealthOptions, "intervalMs" | "timeoutMs"> = {}): ChannelService {
  let host: ReturnType<typeof channelHostFor> | undefined;
  let error: ChannelErrorCode | undefined;
  try {
    host = channelHostFor(cwd);
  } catch (caught) {
    error = caught instanceof ChannelError ? caught.code : "CHANNEL_INVALID_INPUT";
  }
  const monitor = host ? new ChannelHealthMonitor({ registry: host.registry, ...options }) : undefined;
  monitor?.start();
  let stopping: Promise<void> | undefined;
  return {
    list() {
      if (!host) return { connections: [], ...(error ? { error } : {}) };
      const health = monitor?.snapshot() ?? {};
      return { connections: host.registry.list().map(summary => ({ ...summary, ...(health[summary.id] ? { health: health[summary.id] } : {}) })) };
    },
    async checkNow(id) {
      if (!host || !monitor) return undefined;
      try {
        host.registry.get(id);
      } catch {
        return undefined;
      }
      return monitor.checkNow(id);
    },
    stop() {
      return stopping ??= (async () => {
        await monitor?.stop();
        if (host) await releaseChannelHost(cwd);
      })();
    },
  };
}

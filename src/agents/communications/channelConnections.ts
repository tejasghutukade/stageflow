import { createHash } from "node:crypto";
import { channelHostFor } from "../../channels/host.js";
import type { InboundConnections } from "./inbound.js";

const hashOf = (parts: unknown): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** Inbound lookups and replies over the Host's connections (`connections.yaml`). */
export function channelInboundConnections(cwd: string): InboundConnections {
  return {
    find(connectionId) {
      try {
        const host = channelHostFor(cwd);
        const connection = host.registry.resolve(connectionId);
        return { provider: connection.provider, secret: connection.secrets.inboundSecret };
      } catch {
        return undefined;
      }
    },
    async reply(connectionId, to, text, operationKey) {
      const host = channelHostFor(cwd);
      const target = host.registry.validateTarget(connectionId, { to });
      const provider = host.registry.providerFor(connectionId);
      const connection = host.registry.resolve(connectionId);
      const message = { text };
      await host.sends.send(
        { connectionId, operationKey, hash: hashOf([connectionId, to, message]) },
        () => provider.send(connection, target, message, { operationKey }),
      );
    },
  };
}

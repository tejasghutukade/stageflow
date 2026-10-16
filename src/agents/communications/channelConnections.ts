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
      const provider = host.registry.providerFor(connectionId);
      const connection = host.registry.resolve(connectionId);
      const message = { text };
      // A provider that can answer inside the conversation does; otherwise the reply is a new message to the sender.
      const submit = provider.reply
        ? () => provider.reply!(connection, to, message, { operationKey })
        : () => provider.send(connection, host.registry.validateTarget(connectionId, { to }), message, { operationKey });
      await host.sends.send({ connectionId, operationKey, hash: hashOf([connectionId, to, message]) }, submit);
    },
    async contact(connectionId) {
      try {
        const host = channelHostFor(cwd);
        const provider = host.registry.providerFor(connectionId);
        if (!provider.contact) return undefined;
        return await provider.contact(host.registry.resolve(connectionId, false));
      } catch {
        return undefined;
      }
    },
    resolve(connectionId) {
      try {
        const host = channelHostFor(cwd);
        const connection = host.registry.resolve(connectionId);
        return { id: connection.id, provider: connection.provider, config: connection.config, secrets: connection.secrets, credential: connection.credential ? { secrets: connection.credential.secrets } : undefined };
      } catch {
        return undefined;
      }
    },
  };
}

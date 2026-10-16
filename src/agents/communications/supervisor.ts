import { createHash } from "node:crypto";
import type { AgentService } from "../service.js";
import { createAgentMailListener, sdkAgentMailTransport } from "./agentmailListener.js";
import { createIMessageListener, sdkIMessageTransport } from "./imessageListener.js";
import type { ListenerConnection } from "./inbound.js";
import type { ChannelListener, ListenerDeps, ListenerState } from "./listener.js";
import type { AgentInboundMessage } from "./port.js";

export type ListenerFactory = (connection: ListenerConnection, deps: ListenerDeps) => ChannelListener | undefined;

/** Listeners the Host can hold open itself. Other providers (Slack, Telegram) stay on webhooks. */
export const DEFAULT_FACTORIES: Record<string, ListenerFactory> = {
  agentmail: (connection, deps) => {
    const config = connection.config as { inbox?: string; region?: "us" | "eu" };
    const apiKey = connection.secrets.apiKey;
    if (!config.inbox || !apiKey) return undefined;
    return createAgentMailListener({ connectionId: connection.id, inbox: config.inbox }, sdkAgentMailTransport({ apiKey, region: config.region ?? "us", inbox: config.inbox }), deps);
  },
  imessage: (connection, deps) => {
    const secrets = connection.credential?.secrets;
    if (!secrets?.projectId || !secrets.projectSecret) return undefined;
    return createIMessageListener({ connectionId: connection.id }, sdkIMessageTransport({ projectId: secrets.projectId, projectSecret: secrets.projectSecret }), deps);
  },
};

type Running = { listener: ChannelListener; fingerprint: string };

const fingerprintOf = (connection: ListenerConnection): string =>
  createHash("sha256").update(JSON.stringify([connection.provider, connection.config, connection.secrets, connection.credential?.secrets])).digest("hex");

/**
 * Keeps one listener per connection that an enabled agent answers on: starts it when the agent is enabled or
 * linked, restarts it when the connection's settings change, stops it when no enabled agent uses it.
 * `reconcile` is cheap and idempotent, so it runs on every agent change and on a timer.
 */
export class ChannelSupervisor {
  private readonly running = new Map<string, Running>();
  private chain: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly options: {
      service: Pick<AgentService, "list" | "onChange">;
      projectRoot: string;
      resolve: (connectionId: string) => ListenerConnection | undefined;
      deliver: (message: AgentInboundMessage) => Promise<unknown>;
      log: (message: string) => void;
      factories?: Record<string, ListenerFactory>;
      intervalMs?: number;
    },
  ) {}

  /** Start following agents: listeners for what is linked now, and again after every change. */
  start(): void {
    this.options.service.onChange(() => void this.reconcile());
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), this.options.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  reconcile(): Promise<void> {
    this.chain = this.chain.then(() => this.run()).catch((error) => this.options.log(`channel listeners: ${error instanceof Error ? error.message : String(error)}`));
    return this.chain;
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
    const agents = await this.options.service.list(this.options.projectRoot);
    const wanted = new Set(agents.filter((agent) => agent.enabled && agent.channelConnection).map((agent) => agent.channelConnection!));
    for (const [id, entry] of [...this.running]) {
      const connection = wanted.has(id) ? this.options.resolve(id) : undefined;
      if (connection && fingerprintOf(connection) === entry.fingerprint) continue;
      await entry.listener.stop().catch(() => undefined);
      this.running.delete(id);
    }
    for (const id of wanted) {
      if (this.running.has(id) || this.stopped) continue;
      const connection = this.options.resolve(id);
      const factory = connection ? (this.options.factories ?? DEFAULT_FACTORIES)[connection.provider] : undefined;
      if (!connection || !factory) continue;
      const listener = factory(connection, { onMessage: async (message) => void (await this.options.deliver(message)), log: this.options.log });
      if (!listener) continue;
      this.running.set(id, { listener, fingerprint: fingerprintOf(connection) });
      await listener.start();
    }
  }

  /** The state of the listener on a connection, or undefined when none runs (webhook providers, no enabled agent). */
  status(connectionId: string): ListenerState | undefined {
    return this.running.get(connectionId)?.listener.state();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.chain.catch(() => undefined);
    await Promise.all([...this.running.values()].map((entry) => entry.listener.stop().catch(() => undefined)));
    this.running.clear();
  }
}

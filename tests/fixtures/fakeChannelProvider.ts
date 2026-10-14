import type { AnyChannelProvider, ConnectionHealth, OutboundMessage, SendContext, SendReceipt } from "../../src/channels/types.js";

export type FakeSend = { connectionId: string; target: string; message: OutboundMessage; context: SendContext; token?: string };

export function fakeChannelProvider(options: { id?: string; credentialProvider?: string; withTargetCheck?: boolean } = {}): AnyChannelProvider & {
  sent: FakeSend[];
  health: ConnectionHealth["state"];
  failWith?: Error;
  delayMs: number;
  checkQueue: (() => ConnectionHealth | Promise<ConnectionHealth>)[];
  checkCalls: number;
  targetChecks: { targets: unknown[] }[];
  targetHealth: ConnectionHealth["state"];
} {
  const sent: FakeSend[] = [];
  const provider = {
    id: options.id ?? "fake",
    meta: {
      label: "Fake", blurb: "Not connected", icon: "plug",
      fields: [], recipient: { label: "To", placeholder: "", multiple: false, cc: false, template: false },
      envNames: [], yamlExample: "", stageExample: "    to: x",
    },
    operations: ["send"] as const,
    secrets: { required: ["token"], optional: ["extra"] },
    credentialProvider: options.credentialProvider,
    sent,
    health: "ok" as ConnectionHealth["state"],
    failWith: undefined as Error | undefined,
    delayMs: 0,
    checkQueue: [] as (() => ConnectionHealth | Promise<ConnectionHealth>)[],
    checkCalls: 0,
    targetChecks: [] as { targets: unknown[] }[],
    targetHealth: "ok" as ConnectionHealth["state"],
    validateConfig(config: unknown) {
      const c = config as { inbox?: unknown } | null;
      return typeof c?.inbox === "string" && Object.keys(c).length === 1
        ? { ok: true as const, value: { inbox: c.inbox } }
        : { ok: false as const, issues: ["config"] };
    },
    validateTarget(target: unknown) {
      const t = target as { to?: unknown; cc?: unknown } | null;
      return typeof t?.to === "string" && t.to.length > 0 && t.cc === undefined
        ? { ok: true as const, value: t.to }
        : { ok: false as const, issues: ["target"] };
    },
    describe(config: { inbox: string }) {
      return { identity: config.inbox };
    },
    async check(): Promise<ConnectionHealth> {
      provider.checkCalls++;
      const scripted = provider.checkQueue.shift();
      if (scripted) return scripted();
      const checkedAt = new Date().toISOString();
      return provider.health === "ok"
        ? { state: "ok", checkedAt }
        : { state: "failed", checkedAt, error: { code: "CHANNEL_AUTH_FAILED", retryable: false } };
    },
    async send(connection: { id: string; secrets: Record<string, string> }, target: string, message: OutboundMessage, context: SendContext): Promise<SendReceipt> {
      if (provider.delayMs) await new Promise(resolve => setTimeout(resolve, provider.delayMs));
      if (provider.failWith) throw provider.failWith;
      sent.push({ connectionId: connection.id, target, message, context, token: connection.secrets.token });
      return { providerMessageId: `fake-${sent.length}`, submittedAt: new Date().toISOString() };
    },
  };
  if (options.withTargetCheck) {
    Object.assign(provider, {
      async checkTargets(_connection: unknown, targets: unknown[]): Promise<ConnectionHealth> {
        provider.targetChecks.push({ targets });
        const checkedAt = new Date().toISOString();
        return provider.targetHealth === "ok"
          ? { state: "ok", checkedAt }
          : { state: "failed", checkedAt, error: { code: "CHANNEL_RECIPIENT_REJECTED", retryable: false } };
      },
    });
  }
  return provider as never;
}

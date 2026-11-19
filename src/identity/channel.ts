import type { CustomerDataAdapter, SenderLookup } from "./customerApi.js";
import type { ConsumerIdentityStore } from "./store.js";
import { CHANNEL_GRANT_MS, CHANNEL_SENDER_CACHE_MS, type ChannelAssurance, type ChannelProvider } from "./types.js";

export type ChannelAdmission =
  | { outcome: "not_required" }
  | { outcome: "unmapped"; reply: string; reason: string }
  | { outcome: "admitted"; sessionId: string; accountId: string; assurance: ChannelAssurance };

export class ChannelSenderCache {
  private readonly entries = new Map<string, { at: number; status: "found" | "not_found"; accountId?: string }>();

  read(key: string, now: number): { status: "found"; accountId: string } | { status: "not_found" } | undefined {
    const hit = this.entries.get(key);
    if (!hit || now - hit.at >= CHANNEL_SENDER_CACHE_MS) return undefined;
    if (hit.status === "found" && hit.accountId) return { status: "found", accountId: hit.accountId };
    return hit.status === "not_found" ? { status: "not_found" } : undefined;
  }

  write(key: string, now: number, value: { status: "found"; accountId: string } | { status: "not_found" }): void {
    this.entries.set(key, { at: now, status: value.status, ...(value.status === "found" ? { accountId: value.accountId } : {}) });
  }
}

export function channelSubject(provider: ChannelProvider, raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  const angle = /<([^<>]+)>/.exec(raw);
  const value = (angle ? angle[1]! : raw).trim();
  const normalized = /^[+\d][\d\s().-]*$/.test(value) ? value.replace(/[\s().-]/g, "") : value.toLowerCase();
  if (provider === "imessage") return /^\+[1-9]\d{6,14}$/.test(normalized) ? normalized : null;
  if (provider === "telegram") return /^\d{1,16}$/.test(normalized) ? normalized : null;
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized) ? normalized : null;
}

export async function admitChannelSender(
  store: ConsumerIdentityStore,
  cache: ChannelSenderCache,
  orders: CustomerDataAdapter,
  input: { agentId: string; channelConnectionId: string; provider: string; sender: string | undefined; conversationId?: string; dmarcPass?: boolean; signal: AbortSignal },
): Promise<ChannelAdmission> {
  if (input.provider !== "imessage" && input.provider !== "telegram" && input.provider !== "agentmail" && input.provider !== "email") {
    return { outcome: "not_required" };
  }
  const channel = store.findChannelConnection(input.agentId, input.channelConnectionId, input.provider);
  if (!channel) return { outcome: "not_required" };
  const deny = (reason: string, principalId: string | null = null): ChannelAdmission => {
    store.audit(principalId, input.conversationId ?? null, "deny", reason);
    return { outcome: "unmapped", reply: channel.unmappedReply, reason };
  };
  if (!channel.active) return deny("connection_inactive");
  const subject = channelSubject(input.provider, input.sender);
  if (!subject) return deny("sender_malformed");
  if ((input.provider === "agentmail" || input.provider === "email") && input.dmarcPass !== true) return deny("dmarc_failed");
  const row = store.principalState(channel.id, subject);
  if (row && !row.active) return deny("sender_revoked", row.id);

  const accountId = await resolveAccount(store, cache, orders, channel.id, input.provider, subject, row, input.signal);
  if (accountId.status !== "account") return deny(accountId.reason, row?.id ?? null);
  const principalId = store.upsertLookupPrincipal(channel.id, subject, accountId.accountId);
  const principal = store.principalState(channel.id, subject);
  if (!principal?.active || principal.accountId !== accountId.accountId) return deny("sender_unmapped", principal?.id ?? principalId);

  const latest = store.latestChannelSession(principal.id, input.agentId);
  if (latest && !latest.grantActive && latest.expires > store.currentTime()) return deny("grant_revoked", principal.id);

  if (input.conversationId) {
    const binding = store.bindingFor(input.conversationId);
    if (binding?.agentId === input.agentId) {
      try {
        const live = store.resolve(binding.sessionId, input.agentId);
        if (live.principal.id === principal.id && live.principal.accountId === accountId.accountId && live.principal.subject === subject) {
          return { outcome: "admitted", sessionId: live.sessionId, accountId: accountId.accountId, assurance: channel.assurance };
        }
      } catch {
        // The previous grant no longer resolves. A new one is opened below when the latest grant was not revoked.
      }
    }
  }

  const opened = store.openChannelSession(channel.id, input.agentId, subject, store.currentTime() + CHANNEL_GRANT_MS, channel.assurance);
  return { outcome: "admitted", sessionId: opened.sessionId, accountId: accountId.accountId, assurance: channel.assurance };
}

async function resolveAccount(
  store: ConsumerIdentityStore,
  cache: ChannelSenderCache,
  orders: CustomerDataAdapter,
  connectionId: string,
  provider: ChannelProvider,
  subject: string,
  row: { accountId: string; mappingSource: string; active: boolean } | undefined,
  signal: AbortSignal,
): Promise<{ status: "account"; accountId: string } | { status: "deny"; reason: string }> {
  if (!orders.resolveSender) return manualAccount(row);
  const key = `${store.workspaceId}\0${connectionId}\0${subject}`;
  const now = store.currentTime();
  let lookup = cache.read(key, now) as SenderLookup | undefined;
  if (!lookup) {
    try {
      lookup = await orders.resolveSender(store.workspaceId, provider, subject, signal);
    } catch {
      lookup = { status: "failed" };
    }
    if (lookup.status === "found" || lookup.status === "not_found") cache.write(key, now, lookup);
  }
  if (lookup.status === "unavailable") return manualAccount(row);
  if (lookup.status === "failed") return { status: "deny", reason: "lookup_failed" };
  if (lookup.status === "found") return { status: "account", accountId: lookup.accountId };
  if (row?.active && row.mappingSource !== "lookup") return { status: "account", accountId: row.accountId };
  return { status: "deny", reason: "sender_unmapped" };
}

function manualAccount(row: { accountId: string; active: boolean } | undefined): { status: "account"; accountId: string } | { status: "deny"; reason: string } {
  if (row?.active) return { status: "account", accountId: row.accountId };
  return { status: "deny", reason: "sender_unmapped" };
}

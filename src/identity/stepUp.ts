import { randomBytes } from "node:crypto";
import { STEP_UP_LINK_MS, SIGNED_IN_ELEVATION_MS, stepUpReply } from "./assurance.js";
import type { ConsumerIdentityStore } from "./store.js";
import { ConsumerAccessError } from "./types.js";

export function buildStepUpPath(slug: string, token: string): string {
  return `/api/public/chat/${encodeURIComponent(slug)}/step-up?token=${encodeURIComponent(token)}`;
}

function originFromEnvValue(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  try {
    const url = new URL(value.trim());
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return undefined;
    if (url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function resolveStepUpOrigin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return originFromEnvValue(env.STAGEFLOW_PUBLIC_CHAT_URL) ?? originFromEnvValue(env.STAGEFLOW_PUBLIC_URL);
}

export function issueStepUp(
  store: ConsumerIdentityStore,
  input: { channelSessionId: string; agentId: string; accountId: string; principalId: string; slug: string },
  origin: string,
): { token: string; url: string; reply: string } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = store.currentTime() + STEP_UP_LINK_MS;
  store.insertStepUp({
    token,
    channelSessionId: input.channelSessionId,
    agentId: input.agentId,
    accountId: input.accountId,
    principalId: input.principalId,
    expiresAt,
  });
  store.audit(input.principalId, null, "allow", "step_up_issued");
  const path = buildStepUpPath(input.slug, token);
  const absolute = `${origin}${path}`;
  return { token, url: absolute, reply: stepUpReply(absolute) };
}

export function tryCompleteStepUp(store: ConsumerIdentityStore, token: string, signedInAccountId: string): void {
  const peeked = store.peekStepUp(token);
  if (!peeked) {
    store.consumeStepUp(token);
    return;
  }
  if (peeked.accountId !== signedInAccountId) {
    store.audit(peeked.principalId, null, "deny", "step_up_denied_account_mismatch");
    return;
  }
  const row = store.consumeStepUp(token);
  if (!row) return;
  store.elevateChannelSession(row.channelSessionId, "signed_in", store.currentTime() + SIGNED_IN_ELEVATION_MS);
  store.audit(row.principalId, null, "allow", "step_up_completed");
}

export function peekStepUpAccount(store: ConsumerIdentityStore, token: string): string | undefined {
  return store.peekStepUp(token)?.accountId;
}

export class ConsumerStepUpRequired extends ConsumerAccessError {
  constructor(readonly reply: string) {
    super("identity.step_up_required");
  }
}
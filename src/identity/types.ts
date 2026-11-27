export type ConsumerScope = "own" | "assigned" | "selected" | "workspace";

export type ChannelProvider = "imessage" | "telegram" | "agentmail" | "email";

export type ChannelAssurance = "provider_verified" | "address_only";

/** How long a resolve-sender result is reused. A changed number stops working after this. */
export const CHANNEL_SENDER_CACHE_MS = 300_000;

/** A channel has no sign-in moment. The grant is re-read on every message and expires with the session. */
export const CHANNEL_GRANT_MS = 24 * 60 * 60 * 1000;

export type ConsumerPermission = {
  scope: ConsumerScope;
  agents: string[];
  actions: string[];
  resources?: string[];
};

export type ConsumerPrincipal = {
  id: string;
  workspaceId: string;
  connectionId: string;
  subject: string;
  accountId: string;
  mappingSource: string;
  revision: number;
  permission: ConsumerPermission;
};

export type ConsumerAuthority = {
  principal: ConsumerPrincipal;
  sessionId: string;
  grantId: string;
  agentId: string;
  expiresAt: number;
  actions: string[];
  resources: string[] | null;
};

export type ConsumerAdmission = { token: string; expiresAt: number; sessionId: string };

export type OwnedResource = {
  id: string;
  workspaceId: string;
  ownerAccountId: string;
  assignedAccountIds: string[];
  version: string;
};

export type AuthorizationInput = {
  authority: ConsumerAuthority;
  action: string;
  resource: OwnedResource;
  policyRevision: string;
};

export interface AuthorizationEngine {
  check(input: AuthorizationInput, signal: AbortSignal): Promise<boolean>;
}

export type ConsumerRuntimeTool = {
  name: string;
  grantId: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(input: Record<string, unknown>, signal: AbortSignal): Promise<string>;
};

export class ConsumerAccessError extends Error {
  constructor(readonly code: "identity.verification_required" | "identity.not_available" | "identity.setup_required" | "identity.conflict" | "identity.step_up_required") {
    super(code);
  }
}

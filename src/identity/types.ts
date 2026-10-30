export type ConsumerScope = "own" | "assigned" | "selected" | "workspace";

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
  constructor(readonly code: "identity.verification_required" | "identity.not_available" | "identity.setup_required" | "identity.conflict") {
    super(code);
  }
}

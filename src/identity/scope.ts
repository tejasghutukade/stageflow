import type { AuthorizationEngine, AuthorizationInput, ConsumerAuthority, ConsumerScope, OwnedResource } from "./types.js";

export function scopeAllows(input: {
  workspaceId: string;
  accountId: string;
  scope: ConsumerScope;
  resources: readonly string[] | null;
  order: OwnedResource;
}): boolean {
  if (input.order.workspaceId !== input.workspaceId) return false;
  if (input.scope === "own") return input.order.ownerAccountId === input.accountId;
  if (input.scope === "assigned") return input.order.assignedAccountIds.includes(input.accountId);
  if (input.scope === "selected") return input.resources?.includes(input.order.id) === true;
  return input.scope === "workspace";
}

export function createScopeAuthorizationEngine(): AuthorizationEngine {
  return {
    async check(input: AuthorizationInput): Promise<boolean> {
      return relationAllows(input);
    },
  };
}

export async function allowWithinScope(engine: AuthorizationEngine, input: AuthorizationInput, signal: AbortSignal): Promise<boolean> {
  if (!relationAllows(input)) return false;
  return engine.check(input, signal);
}

function relationAllows(input: AuthorizationInput): boolean {
  const permission = input.authority.principal.permission;
  if (input.action !== "order:read") return false;
  return scopeAllows({
    workspaceId: input.authority.principal.workspaceId,
    accountId: input.authority.principal.accountId,
    scope: permission.scope,
    resources: permission.resources ?? null,
    order: input.resource,
  });
}

export function previewAuthority(workspaceId: string, accountId: string, scope: ConsumerScope, resources: string[] | null, now: number): ConsumerAuthority {
  return {
    principal: {
      id: "preview", workspaceId, connectionId: "preview", subject: "preview", accountId,
      mappingSource: "preview", revision: 0,
      permission: { scope, agents: ["preview"], actions: ["order:read"], ...(resources ? { resources } : {}) },
    },
    sessionId: "preview", grantId: "preview", agentId: "preview", expiresAt: now + 60_000,
    actions: ["order:read"], resources,
  };
}

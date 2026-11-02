import { randomUUID } from "node:crypto";
import { boundedJson, trustedEndpoint } from "./http.js";
import type { AuthorizationEngine, AuthorizationInput } from "./types.js";

export function createCerbosAuthorizationEngine(options: {
  endpoint: string;
  allowLoopback?: boolean;
  fetch?: typeof fetch;
}): AuthorizationEngine {
  const endpoint = trustedEndpoint(options.endpoint, options.allowLoopback === true);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("This increment requires a Workspace-local Cerbos PDP");
  }
  return {
    async check(input: AuthorizationInput, signal: AbortSignal): Promise<boolean> {
      try {
        const { authority, resource, policyRevision } = input;
        const requestId = randomUUID();
        const result = await boundedJson(new URL("/api/check/resources", endpoint), {
          requestId,
          principal: {
            id: authority.principal.id, roles: ["consumer"],
            attr: {
              workspace: authority.principal.workspaceId, account: authority.principal.accountId,
              scope: authority.principal.permission.scope, selected: authority.principal.permission.resources ?? [],
              policy_revision: policyRevision,
            },
          },
          resources: [{ resource: { kind: "order", id: resource.id, policyVersion: policyRevision,
            attr: { workspace: resource.workspaceId, owner: resource.ownerAccountId, assigned: resource.assignedAccountIds } }, actions: ["read"] }],
        }, {}, signal, options.fetch);
        const response = result as { requestId?: unknown; results?: Array<{ resource?: { kind?: unknown; id?: unknown; policyVersion?: unknown }; actions?: Record<string, unknown> }> };
        const decision = response.results?.[0];
        return response.requestId === requestId && response.results?.length === 1
          && decision?.resource?.kind === "order" && decision.resource.id === resource.id
          && decision.resource.policyVersion === policyRevision && decision.actions?.read === "EFFECT_ALLOW";
      } catch { return false; }
    },
  };
}

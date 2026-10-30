import { randomUUID } from "node:crypto";
import { z } from "zod";
import { boundedJson, trustedEndpoint } from "./http.js";
import type { ConsumerAuthority, OwnedResource } from "./types.js";

export const ORDER_TOOL_ID = "orders.status";
export const orderInput = z.strictObject({ orderId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
export const orderOwnership = z.strictObject({
  id: z.string().min(1), workspaceId: z.string().min(1), ownerAccountId: z.string().min(1),
  assignedAccountIds: z.array(z.string().min(1)).max(1000), version: z.string().min(1),
});
const statusSchema = z.strictObject({ orderId: z.string(), status: z.string().max(200), updatedAt: z.string().datetime() });

export type OrderStatus = z.infer<typeof statusSchema>;
export interface OrderDataAdapter {
  ownership(workspaceId: string, orderId: string, signal: AbortSignal): Promise<OwnedResource>;
  read(authority: ConsumerAuthority, resource: OwnedResource, signal: AbortSignal): Promise<OrderStatus>;
}

export function createOrderApiAdapter(options: {
  endpoint: string;
  audience: string;
  credential(workspaceId: string): Promise<string>;
  signContext(claims: Record<string, unknown>): Promise<string>;
  fetch?: typeof fetch;
  allowLoopback?: boolean;
}): OrderDataAdapter {
  const endpoint = trustedEndpoint(options.endpoint, options.allowLoopback === true);
  return {
    async ownership(workspaceId, orderId, signal) {
      const credential = await options.credential(workspaceId);
      if (!credential) throw new Error("order_unavailable");
      const resource = orderOwnership.parse(await boundedJson(new URL("/stageflow/order-ownership", endpoint),
        { workspaceId, orderId }, { Authorization: `Bearer ${credential}` }, signal, options.fetch));
      if (resource.workspaceId !== workspaceId || resource.id !== orderId) throw new Error("order_unavailable");
      return resource;
    },
    async read(authority, resource, signal) {
      const workspaceId = authority.principal.workspaceId;
      const credential = await options.credential(workspaceId);
      if (!credential) throw new Error("order_unavailable");
      const now = Math.floor(Date.now() / 1000);
      const context = await options.signContext({
        iss: "stageflow", aud: options.audience, sub: authority.principal.id, workspace: workspaceId,
        agent: authority.agentId, grant: authority.grantId, account: authority.principal.accountId,
        action: "order:read", resource: resource.id, resource_version: resource.version,
        scope: authority.principal.permission.scope, permission_revision: authority.principal.revision,
        iat: now, exp: Math.min(now + 30, Math.floor(authority.expiresAt / 1000)), jti: randomUUID(),
      });
      if (!context) throw new Error("order_unavailable");
      const result = z.strictObject({
        ownership: orderOwnership,
        receipt: z.strictObject({ principalId: z.string(), grantId: z.string() }),
        status: statusSchema,
      }).parse(await boundedJson(new URL("/stageflow/order-status", endpoint),
        { orderId: resource.id, expectedVersion: resource.version },
        { Authorization: `Bearer ${credential}`, "Stageflow-Authorization": context }, signal, options.fetch));
      if (result.receipt.principalId !== authority.principal.id || result.receipt.grantId !== authority.grantId
        || result.status.orderId !== resource.id || result.ownership.workspaceId !== workspaceId
        || result.ownership.id !== resource.id || result.ownership.version !== resource.version
        || result.ownership.ownerAccountId !== resource.ownerAccountId
        || JSON.stringify(result.ownership.assignedAccountIds) !== JSON.stringify(resource.assignedAccountIds)) throw new Error("order_unavailable");
      return result.status;
    },
  };
}

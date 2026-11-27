import { randomUUID } from "node:crypto";
import { z } from "zod";
import { boundedJson, boundedPost, trustedEndpoint } from "./http.js";
import {
  DEFAULT_RESOURCE_TYPES,
  type ResourceTypeDefinition,
  resolveResourceTool,
} from "./resourceContract.js";
import type { ConsumerAuthority, OwnedResource } from "./types.js";

export const orderOwnership = z.strictObject({
  id: z.string().min(1), workspaceId: z.string().min(1), ownerAccountId: z.string().min(1),
  assignedAccountIds: z.array(z.string().min(1)).max(1000), version: z.string().min(1),
});
export const orderInput = z.strictObject({ orderId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
const statusSchema = z.strictObject({ orderId: z.string(), status: z.string().max(200), updatedAt: z.string().datetime() });
const listSchema = z.strictObject({
  resources: z.array(z.strictObject({ id: z.string().min(1), version: z.string().min(1) })).max(1000),
});
const profileSchema = z.strictObject({ accountId: z.string().min(1), displayName: z.string().max(200) });
const senderAccount = z.strictObject({ accountId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });

export type OrderStatus = z.infer<typeof statusSchema>;
export type AccountProfile = z.infer<typeof profileSchema>;

export type SenderLookup =
  | { status: "found"; accountId: string }
  | { status: "not_found" }
  | { status: "unavailable" }
  | { status: "failed" };

export interface CustomerDataAdapter {
  ownership(workspaceId: string, typeId: string, resourceId: string, ownershipIdField: "orderId" | "accountId", signal: AbortSignal): Promise<OwnedResource>;
  read(typeId: string, authority: ConsumerAuthority, resource: OwnedResource, contextAction: string, readPath: string, signal: AbortSignal): Promise<OrderStatus | AccountProfile>;
  list(typeId: string, authority: ConsumerAuthority, listPath: string, signal: AbortSignal): Promise<Array<{ id: string; version: string }>>;
  resolveSender?(workspaceId: string, channel: string, sender: string, signal: AbortSignal): Promise<SenderLookup>;
}

export interface OrderDataAdapter {
  ownership(workspaceId: string, orderId: string, signal: AbortSignal): Promise<OwnedResource>;
  read(authority: ConsumerAuthority, resource: OwnedResource, signal: AbortSignal): Promise<OrderStatus>;
  resolveSender?(workspaceId: string, channel: string, sender: string, signal: AbortSignal): Promise<SenderLookup>;
}

export function createCustomerApiAdapter(options: {
  endpoint: string;
  audience: string;
  credential(workspaceId: string): Promise<string>;
  signContext(claims: Record<string, unknown>): Promise<string>;
  resourceTypes?: readonly ResourceTypeDefinition[];
  fetch?: typeof fetch;
  allowLoopback?: boolean;
}): CustomerDataAdapter {
  const endpoint = trustedEndpoint(options.endpoint, options.allowLoopback === true);
  const types = options.resourceTypes ?? DEFAULT_RESOURCE_TYPES;

  async function credential(workspaceId: string): Promise<string> {
    const value = await options.credential(workspaceId);
    if (!value) throw new Error("order_unavailable");
    return value;
  }

  return {
    async ownership(workspaceId, typeId, resourceId, ownershipIdField, signal) {
      const type = types.find((row) => row.id === typeId);
      if (!type) throw new Error("order_unavailable");
      const body = ownershipIdField === "accountId"
        ? { workspaceId, accountId: resourceId }
        : { workspaceId, orderId: resourceId };
      const resource = orderOwnership.parse(await boundedJson(new URL(type.ownershipPath, endpoint), body,
        { Authorization: `Bearer ${await credential(workspaceId)}` }, signal, options.fetch));
      if (resource.workspaceId !== workspaceId || resource.id !== resourceId) throw new Error("order_unavailable");
      return resource;
    },
    async read(typeId, authority, resource, contextAction, readPath, signal) {
      const workspaceId = authority.principal.workspaceId;
      const token = await options.credential(workspaceId);
      if (!token) throw new Error("order_unavailable");
      const now = Math.floor(Date.now() / 1000);
      const context = await options.signContext({
        iss: "stageflow", aud: options.audience, sub: authority.principal.id, workspace: workspaceId,
        agent: authority.agentId, grant: authority.grantId, account: authority.principal.accountId,
        action: contextAction, resource: resource.id, resource_version: resource.version,
        scope: authority.principal.permission.scope, permission_revision: authority.principal.revision,
        iat: now, exp: Math.min(now + 30, Math.floor(authority.expiresAt / 1000)), jti: randomUUID(),
      });
      if (!context) throw new Error("order_unavailable");
      const requestBody = typeId === "account"
        ? { accountId: resource.id, expectedVersion: resource.version }
        : { orderId: resource.id, expectedVersion: resource.version };
      const envelope = z.strictObject({
        ownership: orderOwnership,
        receipt: z.strictObject({ principalId: z.string(), grantId: z.string() }),
        status: statusSchema.optional(),
        profile: profileSchema.optional(),
      }).parse(await boundedJson(new URL(readPath, endpoint), requestBody,
        { Authorization: `Bearer ${token}`, "Stageflow-Authorization": context }, signal, options.fetch));
      assertReceipt(envelope, authority, resource, workspaceId);
      if (typeId === "account") {
        const profile = envelope.profile;
        if (!profile || profile.accountId !== resource.id) throw new Error("order_unavailable");
        return profile;
      }
      const status = envelope.status;
      if (!status || status.orderId !== resource.id) throw new Error("order_unavailable");
      return status;
    },
    async list(_typeId, authority, listPath, signal) {
      const workspaceId = authority.principal.workspaceId;
      const token = await credential(workspaceId);
      const body = { workspaceId, accountId: authority.principal.accountId };
      const parsed = listSchema.parse(await boundedJson(new URL(listPath, endpoint), body,
        { Authorization: `Bearer ${token}` }, signal, options.fetch));
      return parsed.resources;
    },
    async resolveSender(workspaceId, channel, sender, signal) {
      try {
        const token = await options.credential(workspaceId);
        if (!token) return { status: "failed" };
        const response = await boundedPost(new URL("/stageflow/resolve-sender", endpoint),
          { workspaceId, channel, sender }, { Authorization: `Bearer ${token}` }, signal, options.fetch);
        if (response.status === 404) return { status: "not_found" };
        if (response.status < 200 || response.status >= 300) return { status: "failed" };
        const parsed = senderAccount.safeParse(response.json);
        if (!parsed.success) return { status: "failed" };
        return { status: "found", accountId: parsed.data.accountId };
      } catch {
        return { status: "failed" };
      }
    },
  };
}

export function customerAdapterFromOrders(orders: OrderDataAdapter): CustomerDataAdapter {
  return {
    ownership(workspaceId, typeId, resourceId, ownershipIdField, signal) {
      if (typeId === "orders" && ownershipIdField === "orderId") return orders.ownership(workspaceId, resourceId, signal);
      if (typeId === "account" && ownershipIdField === "accountId") {
        return Promise.resolve({
          id: resourceId, workspaceId, ownerAccountId: resourceId, assignedAccountIds: [], version: "1",
        });
      }
      throw new Error("order_unavailable");
    },
    read(typeId, authority, resource, contextAction, readPath, signal) {
      if (typeId !== "orders") throw new Error("order_unavailable");
      return orders.read(authority, resource, signal);
    },
    async list() {
      return [];
    },
    resolveSender: orders.resolveSender?.bind(orders),
  };
}

function isCustomerDataAdapter(adapter: CustomerDataAdapter | OrderDataAdapter): adapter is CustomerDataAdapter {
  return typeof (adapter as CustomerDataAdapter).list === "function";
}

export function customerAdapterFromInput(adapter: CustomerDataAdapter | OrderDataAdapter): CustomerDataAdapter {
  return isCustomerDataAdapter(adapter) ? adapter : customerAdapterFromOrders(adapter);
}

export function createOrderApiAdapter(options: Parameters<typeof createCustomerApiAdapter>[0]): OrderDataAdapter {
  const customer = createCustomerApiAdapter(options);
  const orders = DEFAULT_RESOURCE_TYPES.find((row) => row.id === "orders")!;
  return {
    ownership: (workspaceId, orderId, signal) => customer.ownership(workspaceId, "orders", orderId, "orderId", signal),
    read: (authority, resource, signal) => customer.read("orders", authority, resource, "order:read", orders.readPath, signal) as Promise<OrderStatus>,
    resolveSender: customer.resolveSender?.bind(customer),
  };
}

export function toolUsesCustomerApi(toolId: string, types: readonly ResourceTypeDefinition[] = DEFAULT_RESOURCE_TYPES): boolean {
  return resolveResourceTool(types, toolId) !== undefined;
}

function assertReceipt(
  envelope: { ownership: z.infer<typeof orderOwnership>; receipt: { principalId: string; grantId: string } },
  authority: ConsumerAuthority,
  resource: OwnedResource,
  workspaceId: string,
): void {
  const { ownership, receipt } = envelope;
  if (receipt.principalId !== authority.principal.id || receipt.grantId !== authority.grantId
    || ownership.workspaceId !== workspaceId || ownership.id !== resource.id
    || ownership.version !== resource.version || ownership.ownerAccountId !== resource.ownerAccountId
    || JSON.stringify(ownership.assignedAccountIds) !== JSON.stringify(resource.assignedAccountIds)) {
    throw new Error("order_unavailable");
  }
}
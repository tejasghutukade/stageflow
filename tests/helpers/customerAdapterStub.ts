import type { AccountProfile, CustomerDataAdapter, OrderStatus } from "../../src/identity/customerApi.js";
import type { ConsumerAuthority, OwnedResource } from "../../src/identity/types.js";

export function orderCustomerStub(options: {
  resources?: Map<string, OwnedResource>;
  ownership?: CustomerDataAdapter["ownership"];
  read?: (typeId: string, resource: OwnedResource) => OrderStatus | AccountProfile;
  list?: CustomerDataAdapter["list"];
  resolveSender?: CustomerDataAdapter["resolveSender"];
} = {}): CustomerDataAdapter {
  const resources = options.resources ?? new Map<string, OwnedResource>();
  return {
    ownership: options.ownership ?? (async (workspaceId, typeId, resourceId, field) => {
      if (typeId === "account" && field === "accountId") {
        const resource: OwnedResource = {
          id: resourceId, workspaceId, ownerAccountId: resourceId, assignedAccountIds: [], version: "1",
        };
        return resource;
      }
      const resource = resources.get(resourceId);
      if (!resource || resource.workspaceId !== workspaceId || typeId !== "orders") throw new Error("order_unavailable");
      return resource;
    }),
    read: async (typeId, _authority, resource, _action, _path) => {
      if (options.read) return options.read(typeId, resource);
      if (typeId === "account") return { accountId: resource.id, displayName: `Account ${resource.id}` };
      return { orderId: resource.id, status: `private-${resource.id}`, updatedAt: "2026-10-30T12:00:00.000Z" };
    },
    list: options.list ?? (async () => []),
    resolveSender: options.resolveSender,
  };
}

export function legacyOrderAdapterFromStub(stub: CustomerDataAdapter): {
  ownership(workspaceId: string, orderId: string, signal: AbortSignal): Promise<OwnedResource>;
  read(authority: ConsumerAuthority, resource: OwnedResource, signal: AbortSignal): Promise<OrderStatus>;
  resolveSender?: CustomerDataAdapter["resolveSender"];
} {
  return {
    ownership: (workspaceId, orderId, signal) => stub.ownership(workspaceId, "orders", orderId, "orderId", signal),
    read: async (authority, resource, signal) => {
      const result = await stub.read("orders", authority, resource, "order:read", "/stageflow/order-status", signal);
      if (!("orderId" in result)) throw new Error("order_unavailable");
      return result;
    },
    resolveSender: stub.resolveSender?.bind(stub),
  };
}
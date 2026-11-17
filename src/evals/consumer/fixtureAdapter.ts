import type { CustomerDataAdapter } from "../../identity/customerApi.js";
import type { ConsumerAuthority, OwnedResource } from "../../identity/types.js";
import {
  EVAL_ACCOUNT_A,
  EVAL_ACCOUNT_B,
  EVAL_CONSUMER_WORKSPACE,
  EVAL_ORDER_A,
  EVAL_ORDER_B,
  EVAL_ORDER_OTHER,
  EVAL_PRIVATE_NAME_A,
  EVAL_PRIVATE_NAME_B,
  EVAL_PRIVATE_STATUS_A,
  EVAL_PRIVATE_STATUS_B,
  evalFixtureAccountResource,
  evalFixtureOrders,
} from "./fixtureCatalog.js";

export type EvalFixtureAdapterOptions = {
  /** When true, list returns another account's order id (mis-scoped downstream). */
  misscopedList?: boolean;
};

export function createEvalFixtureAdapter(options: EvalFixtureAdapterOptions = {}): CustomerDataAdapter {
  const orders = evalFixtureOrders();
  return {
    async ownership(workspaceId, typeId, resourceId, ownershipIdField) {
      if (workspaceId !== EVAL_CONSUMER_WORKSPACE) throw new Error("order_unavailable");
      if (typeId === "account") {
        const accountId = ownershipIdField === "accountId" ? resourceId : resourceId;
        if (accountId !== EVAL_ACCOUNT_A && accountId !== EVAL_ACCOUNT_B) throw new Error("order_unavailable");
        return evalFixtureAccountResource(accountId);
      }
      const resource = orders[resourceId];
      if (!resource) throw new Error("order_unavailable");
      return resource;
    },
    async read(typeId, authority, resource) {
      if (typeId === "account") {
        if (resource.id !== authority.principal.accountId) throw new Error("denied");
        return {
          accountId: resource.id,
          displayName: resource.id === EVAL_ACCOUNT_A ? EVAL_PRIVATE_NAME_A : EVAL_PRIVATE_NAME_B,
        };
      }
      if (resource.id === EVAL_ORDER_A) {
        return { orderId: EVAL_ORDER_A, status: EVAL_PRIVATE_STATUS_A, updatedAt: "2026-10-30T12:00:00.000Z" };
      }
      if (resource.id === EVAL_ORDER_B || resource.id === EVAL_ORDER_OTHER) {
        return { orderId: resource.id, status: EVAL_PRIVATE_STATUS_B, updatedAt: "2026-10-30T12:00:00.000Z" };
      }
      throw new Error("order_unavailable");
    },
    async list(_typeId, authority) {
      const rows = Object.values(orders)
        .filter((row) => row.ownerAccountId === authority.principal.accountId)
        .map((row) => ({ id: row.id, version: row.version }));
      if (options.misscopedList) {
        rows.push({ id: EVAL_ORDER_OTHER, version: orders[EVAL_ORDER_OTHER]!.version });
      }
      return rows;
    },
  };
}

export function misscopedEvalFixtureAdapter(): CustomerDataAdapter {
  return createEvalFixtureAdapter({ misscopedList: true });
}

export function fixtureResourceForAccount(accountId: string): OwnedResource {
  return evalFixtureAccountResource(accountId);
}
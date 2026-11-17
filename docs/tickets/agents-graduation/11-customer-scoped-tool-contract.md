# 11: Customer-scoped tool contract beyond order status

**Epic:** [Agents graduation](README.md) · **Status:** done · **Blocked by:** 09

## Why

A protected agent can do one thing: read an order's status. A real support agent needs more (list my orders, account details, start a return). Generic MCP tools cannot be opened to consumers because nothing forces them to scope to the caller.

## Read first

- `docs/order-api-contract.md`, `src/identity/customerApi.ts`, `resourceContract.ts`, `authorization.ts` (`check`, `tools`), `scope.ts`.
- `docs/functions.md` (reusable JavaScript functions) as a possible carrier.

## What to build (design first, then split)

1. Generalise the order binding into a resource contract: ownership metadata endpoint, a read endpoint that takes the signed context, a receipt. `orders.status` becomes the first instance and keeps passing its tests unchanged.
2. A declaration in the Host's identity settings (not agent YAML) of each resource type: endpoints, audience, actions.
3. A list action: "my orders" returns only resources the downstream service says belong to the mapped account; the Host never asks the model to filter.
4. Writes (returns, address change) are a separate later step and go through ask-first approval or step-up (10).
5. `isConsumerSafeAgent` and `allowConsumerToolCall` accept the declared resource tools, nothing else.

## Acceptance (for the first slice: generalised read + list)

- [x] A second resource type can be added by configuration and a customer-side endpoint, with no Core code change.
- [x] The list action never returns another account's resource, even when the model is told an id (fixture test).
- [x] `docs/order-api-contract.md` becomes a resource contract page with orders as the example; finding and error codes documented.

## Decisions made (2026-11-16, do not revisit)

- Keep and generalise the HTTP contract. No customer-side MCP server for protected data.
- First resource types, in order: orders (list and status), then a read of the account profile. Writes wait for 10.

## Outcome

Shipped the first slice: `DEFAULT_RESOURCE_TYPES` in Host settings data (`orders`, `account`) drive `createCustomerApiAdapter`; `orders.status` behaviour and tests unchanged; `orders.list` and `account.profile` run through the same adapter; list uses the mapped `accountId` only and refuses when a downstream row fails ownership scope; consumer-safe agents allow only declared resource MCP tools. Docs renamed the order page to a customer resource contract.

Left out: writes (returns, address change), console UI to edit the `resources` list, and per-resource audiences or credentials (one base URL and credential as today).
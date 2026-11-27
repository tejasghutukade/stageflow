import { z } from "zod";

export const ORDER_TOOL_ID = "orders.status";
export const ORDER_LIST_TOOL_ID = "orders.list";
export const ACCOUNT_PROFILE_TOOL_ID = "account.profile";

export const CONSUMER_RESOURCE_TOOL_IDS = [ORDER_TOOL_ID, ORDER_LIST_TOOL_ID, ACCOUNT_PROFILE_TOOL_ID] as const;
export type ConsumerResourceToolId = (typeof CONSUMER_RESOURCE_TOOL_IDS)[number];

const pathSuffix = z.string().regex(/^\/stageflow\/[a-z0-9][a-z0-9-]{0,126}$/);

export const resourceToolBindingSchema = z.strictObject({
  permissionAction: z.string().min(1).max(64),
  kind: z.enum(["read", "list", "account_read"]),
  contextAction: z.string().min(1).max(64).optional(),
  ownershipIdField: z.enum(["orderId", "accountId"]).optional(),
});

export const resourceTypeSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  ownershipPath: pathSuffix,
  readPath: pathSuffix,
  listPath: pathSuffix.optional(),
  tools: z.record(z.string(), resourceToolBindingSchema),
});

export type ResourceTypeDefinition = z.infer<typeof resourceTypeSchema>;

export const DEFAULT_RESOURCE_TYPES: ResourceTypeDefinition[] = [
  {
    id: "orders",
    ownershipPath: "/stageflow/order-ownership",
    readPath: "/stageflow/order-status",
    listPath: "/stageflow/orders-list",
    tools: {
      [ORDER_TOOL_ID]: { permissionAction: "order:read", kind: "read", contextAction: "order:read", ownershipIdField: "orderId" },
      [ORDER_LIST_TOOL_ID]: { permissionAction: "order:list", kind: "list" },
    },
  },
  {
    id: "account",
    ownershipPath: "/stageflow/account-ownership",
    readPath: "/stageflow/account-profile",
    tools: {
      [ACCOUNT_PROFILE_TOOL_ID]: { permissionAction: "account:read", kind: "account_read", contextAction: "account:read", ownershipIdField: "accountId" },
    },
  },
];

export function consumerResourceToolIds(types: readonly ResourceTypeDefinition[] = DEFAULT_RESOURCE_TYPES): Set<string> {
  const ids = new Set<string>();
  for (const type of types) for (const toolId of Object.keys(type.tools)) ids.add(toolId);
  return ids;
}

export function resolveResourceTool(types: readonly ResourceTypeDefinition[], toolId: string): { type: ResourceTypeDefinition; binding: z.infer<typeof resourceToolBindingSchema> } | undefined {
  for (const type of types) {
    const binding = type.tools[toolId];
    if (binding) return { type, binding };
  }
  return undefined;
}

export function parseResourceTypes(raw: unknown): ResourceTypeDefinition[] {
  return z.array(resourceTypeSchema).parse(raw);
}
/** Cap for inline pipeline body + skills start payload (1 MiB). */
export const START_PAYLOAD_MAX_BYTES = 1_048_576;

export const START_TOKEN_REJECTED = "start.token_rejected" as const;

/** MCP prefers `checkout`; `checkout_override` remains a temporary alias. */
export function pickCheckoutOverride(args: {
  checkout?: string;
  checkout_override?: string;
}): string | undefined {
  return args.checkout ?? args.checkout_override;
}

const TOKEN_SHAPED_KEY =
  /^(token|github_token|gh_token|access_token|personal_access_token|pat|clone_token|git_token|api_token|auth_token)$/i;

export function isTokenShapedKey(key: string): boolean {
  return TOKEN_SHAPED_KEY.test(key);
}

export function findTokenShapedField(
  value: unknown,
  pathPrefix = "",
): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (isTokenShapedKey(key)) return path;
    if (key === "task" && child !== null && typeof child === "object") {
      const nested = findTokenShapedField(child, path);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

export function tokenRejectedPayload(field: string): {
  error: string;
  code: typeof START_TOKEN_REJECTED;
  field: string;
} {
  return {
    error: `Clone credentials must stay on the Host; reject token-shaped start field "${field}"`,
    code: START_TOKEN_REJECTED,
    field,
  };
}

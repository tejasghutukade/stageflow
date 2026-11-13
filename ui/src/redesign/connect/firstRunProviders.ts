/** Providers a first-time operator is most likely to connect, in display order. */
export const FIRST_RUN_FEATURED_IDS = [
  "openrouter",
  "anthropic",
  "openai",
  "google",
  "cursor",
] as const;

const BLURBS: Record<string, string> = {
  openrouter: "One key reaches many models. A solid first connection.",
  anthropic: "Claude models for stages and agents.",
  openai: "GPT models for stages and agents.",
  google: "Gemini models for stages and agents.",
  cursor: "Cursor models for this operator.",
};

export function firstRunBlurb(providerId: string): string {
  return BLURBS[providerId] ?? "Connect with an API key or a browser sign-in.";
}

export function partitionFirstRunProviders<T extends { id: string }>(
  providers: readonly T[],
): { featured: T[]; other: T[] } {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const featured: T[] = [];
  for (const id of FIRST_RUN_FEATURED_IDS) {
    const hit = byId.get(id);
    if (hit) featured.push(hit);
  }
  const featuredIds = new Set(featured.map((provider) => provider.id));
  const other = providers
    .filter((provider) => !featuredIds.has(provider.id))
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
  return { featured, other };
}

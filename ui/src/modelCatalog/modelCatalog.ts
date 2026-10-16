import type { CatalogModel, CatalogProvider, ModelsResponse } from "../api";

/** Cap on rows rendered at once; OpenRouter lists hundreds, so the picker asks the user to narrow. */
export const MODEL_ROW_LIMIT = 150;

export type ModelGroup = { provider: CatalogProvider; models: CatalogModel[] };

export type ModelFilterResult = {
  groups: ModelGroup[];
  /** Models matching before the row cap. */
  total: number;
  shown: number;
  /** The trimmed query when it is a usable id that no listed model equals, else null. */
  customId: string | null;
};

export function allCatalogModels(providers: readonly CatalogProvider[]): CatalogModel[] {
  return providers.flatMap((provider) => provider.models);
}

/** Case-insensitive match on id and display name; every whitespace-separated term must appear. */
export function modelMatches(model: CatalogModel, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = `${model.id} ${model.name}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function filterModelGroups(providers: readonly CatalogProvider[], query: string, limit = MODEL_ROW_LIMIT): ModelFilterResult {
  const trimmed = query.trim();
  let remaining = limit;
  let total = 0;
  const groups: ModelGroup[] = [];
  for (const provider of providers) {
    const matched = provider.models.filter((model) => modelMatches(model, trimmed));
    total += matched.length;
    if (matched.length === 0 || remaining <= 0) continue;
    const slice = matched.slice(0, remaining);
    remaining -= slice.length;
    groups.push({ provider, models: slice });
  }
  const exact = allCatalogModels(providers).some((model) => model.id === trimmed);
  return {
    groups,
    total,
    shown: groups.reduce((count, group) => count + group.models.length, 0),
    customId: trimmed.length > 0 && !/\s/.test(trimmed) && !exact ? trimmed : null,
  };
}

/** True when a connected provider lists the id. False while nothing is connected, so pickers stay quiet. */
export function isKnownModel(catalog: Pick<ModelsResponse, "providers"> | null, id: string): boolean {
  if (!catalog || catalog.providers.length === 0) return true;
  return allCatalogModels(catalog.providers).some((model) => model.id === id.trim());
}

/** `openrouter/nvidia/nemotron:free` → `nvidia/nemotron:free`; the provider is shown by the group. */
export function modelTail(id: string): string {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(slash + 1) : id;
}

export function formatContextWindow(tokens: number | undefined): string | null {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return null;
  return tokens >= 1_000_000 ? `${+(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;
}

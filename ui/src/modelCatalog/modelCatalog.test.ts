import { describe, expect, it } from "vitest";
import type { CatalogProvider } from "../api";
import { filterModelGroups, formatContextWindow, isKnownModel, modelMatches, modelTail } from "./modelCatalog";

const model = (provider: string, id: string, extra: { name?: string; free?: boolean } = {}) => ({
  id: `${provider}/${id}`,
  provider,
  name: extra.name ?? id,
  free: extra.free ?? false,
  nativeTools: false,
});

const providers: CatalogProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    source: "live",
    models: [model("anthropic", "claude-sonnet-4-5", { name: "Claude Sonnet 4.5" })],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    source: "live",
    models: [
      model("openrouter", "nvidia/nemotron-3.5-lightning:free", { name: "Nemotron Lightning", free: true }),
      model("openrouter", "openai/gpt-oss", { name: "GPT OSS" }),
    ],
  },
];

describe("model catalog helpers", () => {
  it("matches every term against id and display name, case-insensitively", () => {
    const [nemotron] = providers[1]!.models;
    expect(modelMatches(nemotron!, "NEMOTRON free")).toBe(true);
    expect(modelMatches(nemotron!, "lightning")).toBe(true);
    expect(modelMatches(nemotron!, "nemotron claude")).toBe(false);
    expect(modelMatches(nemotron!, "  ")).toBe(true);
  });

  it("groups by provider, drops empty groups and offers a custom id for an unlisted query", () => {
    const hit = filterModelGroups(providers, "gpt");
    expect(hit.groups.map((group) => [group.provider.id, group.models.length])).toEqual([["openrouter", 1]]);
    expect(hit.customId).toBe("gpt");

    const exact = filterModelGroups(providers, "openrouter/openai/gpt-oss");
    expect(exact.customId).toBeNull();

    expect(filterModelGroups(providers, "acme/custom").customId).toBe("acme/custom");
    expect(filterModelGroups(providers, "has space").customId).toBeNull();
    expect(filterModelGroups(providers, "").customId).toBeNull();
  });

  it("caps rendered rows and reports how many matched", () => {
    const many: CatalogProvider[] = [
      { id: "openrouter", name: "OpenRouter", source: "live", models: Array.from({ length: 400 }, (_, index) => model("openrouter", `m${index}`)) },
    ];
    const result = filterModelGroups(many, "", 150);
    expect(result.shown).toBe(150);
    expect(result.total).toBe(400);
    expect(filterModelGroups(many, "m39").total).toBe(11);
  });

  it("treats ids as known only against connected providers, and stays quiet when none are connected", () => {
    expect(isKnownModel({ providers }, "anthropic/claude-sonnet-4-5")).toBe(true);
    expect(isKnownModel({ providers }, "acme/custom")).toBe(false);
    expect(isKnownModel({ providers: [] }, "acme/custom")).toBe(true);
    expect(isKnownModel(null, "acme/custom")).toBe(true);
  });

  it("shortens ids and context windows for display", () => {
    expect(modelTail("openrouter/nvidia/nemotron:free")).toBe("nvidia/nemotron:free");
    expect(modelTail("bare")).toBe("bare");
    expect(formatContextWindow(128000)).toBe("128k");
    expect(formatContextWindow(1_000_000)).toBe("1M");
    expect(formatContextWindow(undefined)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  firstRunBlurb,
  partitionFirstRunProviders,
} from "./firstRunProviders";

describe("partitionFirstRunProviders", () => {
  it("puts common providers first and sorts the rest", () => {
    const { featured, other } = partitionFirstRunProviders([
      { id: "mistral" },
      { id: "openai" },
      { id: "groq" },
      { id: "openrouter" },
      { id: "anthropic" },
    ]);
    expect(featured.map((provider) => provider.id)).toEqual([
      "openrouter",
      "anthropic",
      "openai",
    ]);
    expect(other.map((provider) => provider.id)).toEqual(["groq", "mistral"]);
  });

  it("keeps unknown catalogs entirely in the other list", () => {
    const { featured, other } = partitionFirstRunProviders([
      { id: "zai" },
      { id: "groq" },
    ]);
    expect(featured).toEqual([]);
    expect(other.map((provider) => provider.id)).toEqual(["groq", "zai"]);
  });
});

describe("firstRunBlurb", () => {
  it("explains OpenRouter as a first connection", () => {
    expect(firstRunBlurb("openrouter")).toMatch(/many models/i);
  });

  it("falls back for providers without a dedicated line", () => {
    expect(firstRunBlurb("groq")).toMatch(/API key/i);
  });
});

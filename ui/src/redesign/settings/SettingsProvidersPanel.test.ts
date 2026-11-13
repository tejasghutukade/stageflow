import { describe, expect, it } from "vitest";
import { partitionSettingsProviders } from "./SettingsProvidersPanel";

const providers = [
  { id: "anthropic" },
  { id: "openai" },
  { id: "openai-codex" },
  { id: "openrouter" },
];

describe("partitionSettingsProviders", () => {
  it("leaves an unconnected provider in place while Connect is open", () => {
    const connectingId = "openai-codex";
    const { primary, other } = partitionSettingsProviders(
      providers,
      (provider) => provider.id === "anthropic",
    );
    expect(primary.map((provider) => provider.id)).toEqual(["anthropic"]);
    expect(other.map((provider) => provider.id)).toEqual([
      "openai",
      "openai-codex",
      "openrouter",
    ]);
    expect(other.some((provider) => provider.id === connectingId)).toBe(true);
  });

  it("moves a provider into Accounts only after it is connected", () => {
    const { primary, other } = partitionSettingsProviders(
      providers,
      (provider) => provider.id === "anthropic" || provider.id === "openai-codex",
    );
    expect(primary.map((provider) => provider.id)).toEqual([
      "anthropic",
      "openai-codex",
    ]);
    expect(other.map((provider) => provider.id)).toEqual([
      "openai",
      "openrouter",
    ]);
  });
});

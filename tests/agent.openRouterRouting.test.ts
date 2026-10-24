import { describe, expect, it } from "vitest";
import { createOpenRouterRoutingExtension } from "../src/agent/openRouterRouting.js";

type Handler = (event: { payload: unknown }, ctx: unknown) => unknown;

function install() {
  let handler: Handler | undefined;
  createOpenRouterRoutingExtension()({ on: (_name: string, h: Handler) => void (handler = h) } as never);
  return (payload: unknown, model: unknown) => handler!({ payload }, { model });
}

const tools = [{ type: "function", function: { name: "bash" } }];

describe("OpenRouter routing default", () => {
  it("asks OpenRouter to skip providers that cannot honour the tools", () => {
    const run = install();
    expect(run({ model: "m", tools }, { provider: "openrouter" })).toEqual({ model: "m", tools, provider: { require_parameters: true } });
    expect(run({ model: "m", tools }, { provider: "custom", baseUrl: "https://openrouter.ai/api/v1" })).toMatchObject({ provider: { require_parameters: true } });
  });

  it("keeps routing the Host already set", () => {
    const run = install();
    const out = run({ model: "m", tools, provider: { order: ["SiliconFlow"], allow_fallbacks: false, require_parameters: false } }, { provider: "openrouter" });
    expect(out).toMatchObject({ provider: { order: ["SiliconFlow"], allow_fallbacks: false, require_parameters: false } });
  });

  it("leaves other providers and tool-free requests alone", () => {
    const run = install();
    expect(run({ model: "m", tools }, { provider: "anthropic" })).toBeUndefined();
    expect(run({ model: "m" }, { provider: "openrouter" })).toBeUndefined();
    expect(run({ model: "m", tools: [] }, { provider: "openrouter" })).toBeUndefined();
    expect(run(null, { provider: "openrouter" })).toBeUndefined();
  });
});

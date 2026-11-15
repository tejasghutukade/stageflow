import { describe, expect, it } from "vitest";
import { redactModelsJson } from "../src/archive/redactModels.js";

const parse = (text: string | undefined): unknown => JSON.parse(text ?? "null");

describe("redactModelsJson", () => {
  it("removes credential-shaped names at every depth, including inside arrays", () => {
    const text = JSON.stringify({
      providers: {
        a: { apiKey: "x", api_key: "x", "x-api-key": "x", authToken: "x", clientSecret: "x", password: "x", Authorization: "x", baseUrl: "https://a" },
        b: { models: [{ id: "m", accessToken: "x", credential: "x" }], headers: { anything: "x" }, header: { anything: "x" } },
      },
    });
    expect(parse(redactModelsJson(text))).toEqual({ providers: { a: { baseUrl: "https://a" }, b: { models: [{ id: "m" }] } } });
  });

  it("keeps numbers and routing that merely mention tokens or a window", () => {
    const text = JSON.stringify({ providers: { a: { models: [{ id: "m", maxTokens: 4096, max_tokens: 1, contextWindow: 8192, reasoning: true, cost: { input: 1, output: 2 } }], openRouterRouting: { order: ["x"], allow_fallbacks: false } } } });
    expect(parse(redactModelsJson(text))).toEqual(JSON.parse(text));
  });

  it("answers undefined for text that is not a JSON object, or is too large to trust", () => {
    expect(redactModelsJson("{ nope")).toBeUndefined();
    expect(redactModelsJson("[1,2]")).toBeUndefined();
    expect(redactModelsJson("null")).toBeUndefined();
    expect(redactModelsJson(JSON.stringify({ pad: "x".repeat(5 * 1024 * 1024) }))).toBeUndefined();
  });

  it("ends the output with a newline and is stable when run twice", () => {
    const once = redactModelsJson(JSON.stringify({ a: { apiKey: "x", b: 1 } }));
    expect(once?.endsWith("\n")).toBe(true);
    expect(redactModelsJson(once ?? "")).toBe(once);
  });
});

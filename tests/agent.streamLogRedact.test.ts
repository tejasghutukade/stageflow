import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/agent/streamLogRedact.js";

describe("redactSecrets", () => {
  it("redacts an sk-style key", () => {
    const text = "here is my key: sk-abcdefghijklmnopqrstuvwxyz123456";
    expect(redactSecrets(text)).toBe("here is my key: [redacted]");
  });

  it("redacts a GitHub ghp_ token", () => {
    const text = "token=ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    expect(redactSecrets(text)).toBe("token=[redacted]");
  });

  it("redacts a generic KEY=<long-random-string> assignment", () => {
    const text = 'export API_KEY="aB3dE9fGhJkLmN0pQrStUvWxYz1234567890"';
    expect(redactSecrets(text)).toBe("export [redacted]");
  });

  it("leaves ordinary prose unmodified", () => {
    const text = "The plan is to refactor the loader and add tests, then key in the changes carefully.";
    expect(redactSecrets(text)).toBe(text);
  });

  it("leaves short, non-secret-shaped assignments alone", () => {
    const text = "key = 1";
    expect(redactSecrets(text)).toBe(text);
  });

  it("redacts multiple secrets in the same chunk", () => {
    const text = "first sk-aaaaaaaaaaaaaaaaaaaa then ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbb done";
    expect(redactSecrets(text)).toBe("first [redacted] then [redacted] done");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyRedesignAttribute } from "./flag";

function stubDocument() {
  const attrs = new Map<string, string>();
  vi.stubGlobal("document", {
    documentElement: {
      setAttribute: (name: string, value: string) => {
        attrs.set(name, value);
      },
      removeAttribute: (name: string) => {
        attrs.delete(name);
      },
      getAttribute: (name: string) => attrs.get(name) ?? null,
      hasAttribute: (name: string) => attrs.has(name),
    },
  });
  return attrs;
}

beforeEach(() => {
  stubDocument();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("redesign attribute", () => {
  it("sets data-redesign on the document element", () => {
    applyRedesignAttribute();
    expect(document.documentElement.getAttribute("data-redesign")).toBe("on");
  });
});

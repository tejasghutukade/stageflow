import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRedesignAttribute,
  readRedesignPreference,
  writeRedesignPreference,
} from "./flag";

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
  vi.stubGlobal("window", {
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("redesign flag", () => {
  it("reads and writes sf-ui-redesign", () => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
      removeItem: (key: string) => {
        data.delete(key);
      },
    });
    expect(readRedesignPreference()).toBe(false);
    writeRedesignPreference(true);
    expect(data.get("sf-ui-redesign")).toBe("on");
    expect(readRedesignPreference()).toBe(true);
    writeRedesignPreference(false);
    expect(data.has("sf-ui-redesign")).toBe(false);
    expect(readRedesignPreference()).toBe(false);
  });

  it("sets and removes data-redesign on the document element", () => {
    applyRedesignAttribute(true);
    expect(document.documentElement.getAttribute("data-redesign")).toBe("on");
    applyRedesignAttribute(false);
    expect(document.documentElement.hasAttribute("data-redesign")).toBe(false);
  });
});

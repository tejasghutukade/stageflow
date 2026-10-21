import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("console.css live view rules", () => {
  const css = readFileSync(new URL("../console.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  function topLevelSelectors(): string[] {
    const selectors: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < css.length; i++) {
      if (css[i] === "{") {
        if (depth === 0) selectors.push(css.slice(start, i).trim());
        depth++;
      } else if (css[i] === "}") {
        depth--;
        if (depth === 0) start = i + 1;
      }
    }
    return selectors;
  }

  it("keeps blocks balanced", () => {
    expect((css.match(/{/g) ?? []).length).toBe((css.match(/}/g) ?? []).length);
  });

  it.each([".liveview__kb", ".liveview__dialog", ".liveview__status", ".workshop__bubble", ".watch-browser"])(
    "%s is a top-level rule, not nested in another block",
    (selector) => {
      expect(topLevelSelectors()).toContain(selector);
    },
  );
});

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { seedModelCatalogForTests, resetModelCatalogForTests } from "../modelCatalog/useModelCatalog";
import { ModelPicker } from "./ModelPicker";

const catalog = {
  models: ["anthropic/claude-sonnet-4-5"],
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      source: "live" as const,
      models: [{ id: "anthropic/claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5", free: false, nativeTools: false }],
    },
  ],
  default: "anthropic/claude-sonnet-4-5",
  fetchedAt: "2026-10-16T00:00:00.000Z",
  unlisted: [],
};

function render(props: Partial<Parameters<typeof ModelPicker>[0]> = {}) {
  return renderToStaticMarkup(createElement(ModelPicker, { value: null, onChange: () => undefined, ariaLabel: "Stage model", ...props }));
}

describe("ModelPicker trigger", () => {
  beforeEach(() => {
    resetModelCatalogForTests();
    seedModelCatalogForTests(catalog);
  });

  it("shows the chosen id and no warning when a connected provider lists it", () => {
    const html = render({ value: "anthropic/claude-sonnet-4-5" });
    expect(html).toContain("anthropic/claude-sonnet-4-5");
    expect(html).not.toContain("Not in connected providers");
  });

  it("warns, without refusing, when no connected provider lists the id", () => {
    const html = render({ value: "acme/custom" });
    expect(html).toContain("acme/custom");
    expect(html).toContain("Not in connected providers");
    expect(html).toContain("still used as written");
  });

  it("shows the inherit label when nothing is chosen, and the catalog default when inherit is not offered", () => {
    expect(render({ inheritLabel: "Inherits default" })).toContain("Inherits default");
    expect(render()).toContain("anthropic/claude-sonnet-4-5");
  });

  it("uses the compact tail in the chip variant and can be disabled", () => {
    const html = render({ variant: "chip", value: "anthropic/claude-sonnet-4-5", disabled: true });
    expect(html).toContain("claude-sonnet-4-5");
    expect(html).toContain("disabled");
  });
});

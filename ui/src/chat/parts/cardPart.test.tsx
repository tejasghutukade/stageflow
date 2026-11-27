// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_PART_KIND_CARD, UI_PART_SCHEMA_VERSION } from "../../../../src/artifacts/uiPart.ts";
import { registerBuiltinUiParts } from "./builtins";
import { renderUiPart } from "./registry";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(part: unknown): HTMLDivElement {
  registerBuiltinUiParts();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<div>{renderUiPart(part)}</div>));
  return host;
}

const card = (overrides: Record<string, unknown>) => ({
  v: UI_PART_SCHEMA_VERSION,
  kind: UI_PART_KIND_CARD,
  title: "Regional sales",
  fallback: { text: "Regional sales", url: "" },
  ...overrides,
});

describe("card part", () => {
  it("renders a markdown card from the message alone", () => {
    const el = mount(card({ format: "static.markdown", program: "# Weekly\n\nNorth leads." }));
    expect(el.querySelector('[data-testid="ui-card"]')).not.toBeNull();
    expect(el.textContent).toContain("Regional sales");
    expect(el.textContent).toContain("North leads.");
    expect(el.textContent).not.toContain("Open in console");
  });

  it("renders a declarative card without asking any server for data", async () => {
    await import("../../redesign/artifacts/live/LiveArtifactRenderer");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const el = mount(
      card({
        format: "live.declarative",
        program: 'root = Card([CardHeader("Regional sales", "This week"), TextContent("North 120, South 95")])',
        library: { name: "stageflow", version: "1.0.0" },
      }),
    );
    await vi.waitFor(
      async () => {
        await act(async () => {});
        expect(el.textContent).toContain("North 120, South 95");
      },
      { timeout: 15000 },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  }, 20_000);

  it("falls back to the generic card for a malformed part", () => {
    const el = mount(card({ format: "live.html", program: "<p>x</p>" }));
    expect(el.querySelector('[data-testid="ui-card"]')).toBeNull();
    expect(el.textContent).toContain("Regional sales");
  });
});

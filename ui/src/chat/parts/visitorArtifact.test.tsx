// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_PART_KIND_ARTIFACT_REF, UI_PART_SCHEMA_VERSION } from "../../../../src/artifacts/uiPart.ts";
import { ChatSandboxProvider } from "../../redesign/artifacts/sandbox/sandboxOrigin";
import { registerBuiltinUiParts } from "./builtins";
import { renderUiPart } from "./registry";
import type { VisitorArtifactPayload } from "../api";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const SANDBOX = "http://127.0.0.1:43999";

function part() {
  return {
    v: UI_PART_SCHEMA_VERSION,
    kind: UI_PART_KIND_ARTIFACT_REF,
    key: "agent:helper/chatnote",
    title: "Note",
    fallback: { text: "View in Artifacts", url: "http://127.0.0.1:3847/#/artifacts/x?project_root=/secret" },
  };
}

function mount(payload: VisitorArtifactPayload, sandboxOrigins: string[] = []): HTMLDivElement {
  registerBuiltinUiParts();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <ChatSandboxProvider origins={sandboxOrigins}>
        <div>{renderUiPart(part(), { loadVisitorArtifact: async () => payload })}</div>
      </ChatSandboxProvider>,
    ),
  );
  return host;
}

async function settled(el: HTMLElement, selector: string): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(el.querySelector(selector)).not.toBeNull();
  });
}

describe("visitor artifact ref", () => {
  it("renders a static artifact without a promote button or a console link", async () => {
    const el = mount({ kind: "static.markdown", title: "Note", version: 1, text: "# Hello\n\nNorth leads." });
    await settled(el, '[data-testid="visitor-artifact"]');
    await vi.waitFor(() => expect(el.textContent).toContain("North leads."));
    expect(el.textContent).toContain("Note");
    expect(el.textContent).not.toContain("Promote");
    expect(el.textContent).not.toContain("View in Artifacts");
    expect(el.textContent).not.toContain("Open in console");
    expect(el.innerHTML).not.toContain("project_root");
    expect(el.querySelector("a")).toBeNull();
  });

  it("renders a declarative artifact from the saved program and does not ask the host for data", async () => {
    await import("../../redesign/artifacts/live/LiveArtifactRenderer");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const el = mount({
      kind: "live.declarative",
      title: "Regional sales",
      version: 1,
      text: 'root = Card([CardHeader("Regional sales", "This week"), TextContent("North 120, South 95")])',
      library: { name: "stageflow", version: "1.0.0" },
    });
    await vi.waitFor(
      async () => {
        await act(async () => {});
        expect(el.textContent).toContain("North 120, South 95");
      },
      { timeout: 15000 },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain("Promote");
    expect(el.textContent).not.toContain("Open in console");
    fetchSpy.mockRestore();
  }, 20_000);

  it("frames live HTML in the sandbox with connect-src none and no srcdoc on this page", async () => {
    const el = mount({ kind: "live.html", title: "Pie", version: 1, text: "<p>Chart</p>", libraries: [] }, [SANDBOX]);
    await settled(el, '[data-testid="html-card-shell"], [data-testid="html-card-no-sandbox"]');
    const frame = el.querySelector('[data-testid="html-card-shell"]') as HTMLIFrameElement;
    expect(frame).not.toBeNull();
    expect(frame.src).toContain(`${SANDBOX}/shell.html?parent=`);
    expect(frame.getAttribute("srcdoc")).toBeNull();
    expect(el.querySelector("iframe[srcdoc]")).toBeNull();
    expect(el.querySelector('[data-testid="html-card-frame"]')?.getAttribute("data-csp")).toContain("connect-src 'none'");
    expect(el.textContent).not.toContain("Promote");
    expect(el.querySelector('[data-testid="live-html-origin-banner"]')).toBeNull();
  });
});

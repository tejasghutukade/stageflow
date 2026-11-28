// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UI_PART_KIND_CARD, UI_PART_SCHEMA_VERSION } from "../../../../src/artifacts/uiPart.ts";
import {
  SHELL_ERROR_METHOD,
  SHELL_LOAD_METHOD,
  SHELL_PROTOCOL_VERSION,
  SHELL_READY_METHOD,
  SHELL_RELAY_METHOD,
} from "../../redesign/artifacts/liveHtml/hostBridge";
import { ChatSandboxProvider } from "../../redesign/artifacts/sandbox/sandboxOrigin";
import { createHeightGuard } from "../../redesign/artifacts/sandbox/useSandboxBridge";
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

function mount(part: unknown, sandboxOrigins: string[] = []): HTMLDivElement {
  registerBuiltinUiParts();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <ChatSandboxProvider origins={sandboxOrigins}>
        <div>{renderUiPart(part)}</div>
      </ChatSandboxProvider>,
    ),
  );
  return host;
}

const SANDBOX = "http://127.0.0.1:43999";

/** HTML cards load their frame lazily; wait until it (or the no-sandbox note) is on the page. */
async function mountHtml(part: unknown, sandboxOrigins: string[] = []): Promise<HTMLDivElement> {
  await import("./htmlCardFrame");
  const el = mount(part, sandboxOrigins);
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(el.querySelector('[data-testid="html-card-shell"], [data-testid="html-card-no-sandbox"]')).not.toBeNull();
  });
  return el;
}

/** happy-dom loads no iframe page, so stand in for the shell's window (as LiveHtmlFrame.dom.test does). */
function fakeShell(el: HTMLElement) {
  const frame = el.querySelector('[data-testid="html-card-shell"]') as HTMLIFrameElement;
  const posted: unknown[] = [];
  const win = { postMessage: (message: unknown) => posted.push(message) } as unknown as Window;
  Object.defineProperty(frame, "contentWindow", { configurable: true, value: win });
  return { frame, win, posted };
}

async function emitFrom(win: Window, data: unknown) {
  const event = new MessageEvent("message", { data, origin: SANDBOX });
  Object.defineProperty(event, "source", { value: win });
  await act(async () => {
    window.dispatchEvent(event);
  });
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

  it("shows a sandbox note for an HTML card when no sandbox origin is set", async () => {
    const el = await mountHtml(card({ format: "live.html", program: "<p>x</p>" }));
    expect(el.querySelector('[data-testid="ui-card"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="html-card-no-sandbox"]')?.textContent).toContain("sandbox");
    expect(el.querySelector("iframe[srcdoc]")).toBeNull();
  });

  it("frames an HTML card through the sandbox shell with a tight CSP", async () => {
    const el = await mountHtml(card({ format: "live.html", program: "<p>Chart</p>" }), [SANDBOX]);
    const frame = el.querySelector('[data-testid="html-card-shell"]') as HTMLIFrameElement;
    expect(frame.sandbox.toString()).toContain("allow-scripts");
    expect(frame.src).toContain(`${SANDBOX}/shell.html?parent=`);
    expect(el.querySelector('[data-testid="html-card-frame"]')?.getAttribute("data-csp")).toContain("connect-src 'none'");
    expect(frame.getAttribute("srcdoc")).toBeNull();
  });

  it("shows the card once the shell is ready and keeps honouring its height messages", async () => {
    const el = await mountHtml(card({ format: "live.html", program: "<p>Chart</p>" }), [SANDBOX]);
    const { frame, win, posted } = fakeShell(el);
    const fromShell = (data: unknown) => emitFrom(win, data);
    await fromShell({ jsonrpc: "2.0", method: SHELL_READY_METHOD, params: { version: SHELL_PROTOCOL_VERSION } });
    expect(frame.className).not.toContain("invisible");
    const load = posted.find((message) => (message as { method?: string }).method === SHELL_LOAD_METHOD) as { params: { nonce: string; html: string } };
    expect(load.params.html).toBe("<p>Chart</p>");
    await fromShell({
      jsonrpc: "2.0",
      method: SHELL_RELAY_METHOD,
      params: { nonce: load.params.nonce, message: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 333 } } },
    });
    expect(frame.style.height).toBe("333px");
    expect(frame.className).not.toContain("invisible");
  });

  it("stops a card that sizes itself to its frame from growing without end", async () => {
    const el = await mountHtml(card({ format: "live.html", program: "<body style='min-height:100vh;padding:40px'></body>" }), [SANDBOX]);
    const { frame, win, posted } = fakeShell(el);
    await emitFrom(win, { jsonrpc: "2.0", method: SHELL_READY_METHOD, params: { version: SHELL_PROTOCOL_VERSION } });
    const load = posted.find((message) => (message as { method?: string }).method === SHELL_LOAD_METHOD) as { params: { nonce: string } };
    for (const height of [280, 360, 440, 520, 600, 680]) {
      await emitFrom(win, {
        jsonrpc: "2.0",
        method: SHELL_RELAY_METHOD,
        params: { nonce: load.params.nonce, message: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } } },
      });
    }
    expect(frame.style.height).toBe("360px");
  });

  it("says so when the sandbox refuses the card instead of staying blank", async () => {
    const el = await mountHtml(card({ format: "live.html", program: "<p>Chart</p>" }), [SANDBOX]);
    const { win } = fakeShell(el);
    await emitFrom(win, { jsonrpc: "2.0", method: SHELL_ERROR_METHOD, params: { reason: "csp" } });
    expect(el.querySelector('[data-testid="html-card-stopped"]')?.textContent).toContain("could not be shown");
  });
});

describe("height guard", () => {
  it("follows real size changes and freezes a self-feeding loop one step in", () => {
    const guard = createHeightGuard();
    expect([300, 420, 380, 500].map(guard)).toEqual([300, 420, 380, 500]);
    const loop = createHeightGuard();
    expect([280, 360, 440, 520, 600].map(loop)).toEqual([280, 360, 440, 360, null]);
    expect(loop(300)).toBe(300);
  });

  it("does not lock on equal growth that arrives slowly, and unlocks on reset", () => {
    let at = 0;
    const slow = createHeightGuard(() => at);
    const heights = [280, 360, 440, 520, 600].map((height) => {
      at += 1_000;
      return slow(height);
    });
    expect(heights).toEqual([280, 360, 440, 520, 600]);
    const loop = createHeightGuard(() => at);
    expect([280, 360, 440, 520].map((height) => loop(height))).toEqual([280, 360, 440, 360]);
    expect(loop(760)).toBeNull();
    loop.reset();
    expect(loop(760)).toBe(760);
  });
});

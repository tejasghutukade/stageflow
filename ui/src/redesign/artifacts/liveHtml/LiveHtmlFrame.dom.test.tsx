// @vitest-environment happy-dom
import { act, createElement, StrictMode, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateInitializeResult, type HostContext } from "../../../../../src/artifacts/bridge/protocol.ts";
import type { ArtifactRecord, ArtifactSnapshot } from "../../../api/artifacts";
import { RunCatalogProvider } from "../../../catalog/useRunCatalog";
import { createRunCatalog } from "../../../catalog/runCatalog";
import type { CapacityHealth } from "../../../api";
import { ArtifactDetailView } from "../ArtifactDetailPage";
import { artifactDetailMeta } from "../artifactDetailModel";
import { LiveHtmlFrame, type LiveHtmlFrameProps } from "./LiveHtmlFrame";
import { setSandboxOriginForTests, useSandboxOrigin } from "./sandboxOrigin";
import { resetLiveQueryCacheForTests } from "../liveData/queryCache";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORIGIN = "http://localhost:5999";

function record(patch: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    key: "stage:sales:summarize/weekly",
    id: "weekly",
    title: "Weekly",
    description: null,
    tags: [],
    kind: "live.html",
    origin: "published",
    owner: { kind: "stage", pipeline: "sales", stage: "summarize" },
    source: { run_id: null, stage_id: null, attempt: null, session_id: null },
    version: 2,
    size_bytes: 32,
    content_type: "text/html",
    created_at: "2026-11-25T00:00:00.000Z",
    updated_at: "2026-11-25T00:00:00.000Z",
    expires_at: null,
    status: "available",
    expired_at: null,
    expired_reason: null,
    project: { id: "examples", registered: true },
    live: {
      status: "fresh",
      format: "html",
      bindings: [{ id: "rows", function: "revenue_by_week", args: { weeks: 12 } }],
      csp: { connectDomains: ["https://api.example.com"] },
    },
    ...patch,
  };
}

function snap(value: unknown): ArtifactSnapshot {
  return {
    binding_id: "rows",
    args_hash: "h",
    value,
    fetched_at: "2026-11-25T00:00:00.000Z",
    duration_ms: 1,
    status: "ok",
    error_code: null,
    source: "cache",
  };
}

function props(patch: Partial<LiveHtmlFrameProps> = {}): LiveHtmlFrameProps {
  return {
    record: record(),
    version: 2,
    html: "<p id=\"live\">Hi</p>",
    htmlError: null,
    historical: false,
    snapshots: [snap({ weeks: 12 })],
    settled: true,
    ownerKey: "stage:sales:summarize",
    artifactId: "weekly",
    query: async () => ({ status: 500, body: null }),
    ...patch,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(node);
  });
  return container;
}

function shell() {
  const iframe = container?.querySelector("[data-testid=live-html-shell]") as HTMLIFrameElement | null;
  if (!iframe) throw new Error("shell frame missing");
  const post = vi.fn();
  const win = { postMessage: post } as unknown as Window;
  Object.defineProperty(iframe, "contentWindow", { configurable: true, value: win });
  return { iframe, win, post };
}

function emit(win: Window, data: unknown, origin = ORIGIN, source: unknown = win) {
  const event = new MessageEvent("message", { data, origin });
  Object.defineProperty(event, "source", { value: source });
  act(() => {
    window.dispatchEvent(event);
  });
}

function ready() {
  return { jsonrpc: "2.0", method: "sf/sandbox-ready", params: { version: 1 } };
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  setSandboxOriginForTests("unset");
  resetLiveQueryCacheForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LiveHtmlFrame", () => {
  it("falls back when the sandbox origin is null and waits while health is unknown", async () => {
    await render(createElement(LiveHtmlFrame, props()));
    expect(container?.querySelector("[data-sf-state=Loading]")).toBeTruthy();
    expect(container?.querySelector("iframe")).toBeNull();
    await act(async () => {
      setSandboxOriginForTests(null);
    });
    expect(container?.textContent).toContain("Live preview needs the sandbox origin, which is not available on this Host. Showing a static preview with scripts disabled.");
    const docs = container?.querySelector("[data-docs=live-html-sandbox]");
    expect(docs?.textContent).toBe("Live HTML artifacts: the sandbox origin");
    expect(docs?.getAttribute("href")).toBeNull();
    const preview = container?.querySelector("[data-testid=artifact-html-frame]") as HTMLIFrameElement | null;
    expect(preview?.getAttribute("sandbox")).toBe("");
    expect(container?.querySelector("[data-testid=live-html-shell]")).toBeNull();
  });

  it("handshakes once, clamps size, and notes a blocked link without navigating", async () => {
    vi.useFakeTimers();
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: (name: string) => (name === "--sf-ground" ? "#111111" : name === "--token" ? "secret-token" : ""),
    } as CSSStyleDeclaration);
    setSandboxOriginForTests(ORIGIN);
    await render(createElement(LiveHtmlFrame, props()));
    const { iframe, win, post } = shell();
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.getAttribute("loading")).toBe("eager");
    expect(iframe.title).toBe("Live HTML artifact");
    expect(iframe.src).toBe(`${ORIGIN}/shell.html?parent=${encodeURIComponent(location.origin)}`);
    expect(iframe.src).not.toMatch(/token|Bearer|\/api\//);
    expect(iframe.className).toContain("min-h-[480px]");
    emit(win, ready(), "null");
    emit(win, ready(), location.origin, window);
    emit(win, ready());
    emit(win, ready());
    const loads = post.mock.calls.filter((call) => (call[0] as { method?: string }).method === "sf/sandbox-load");
    expect(loads).toHaveLength(1);
    expect(loads.every((call) => call[1] === ORIGIN)).toBe(true);
    expect(post.mock.calls.some((call) => call[1] === "*")).toBe(false);
    const nonce = (loads[0]?.[0] as { params: { nonce: string } }).params.nonce;
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    post.mockClear();
    emit(win, {
      jsonrpc: "2.0",
      method: "sf/sandbox-relay",
      params: {
        nonce,
        message: {
          jsonrpc: "2.0",
          id: 4,
          method: "ui/initialize",
          params: {
            protocolVersion: "2026-01-26",
            appInfo: { name: "live-html", version: "1" },
            appCapabilities: { availableDisplayModes: ["inline"] },
          },
        },
      },
    });
    const init = post.mock.calls[0]?.[0] as { params: { message: { result: { hostContext: HostContext } } } };
    expect(validateInitializeResult(init.params.message.result)).toBe(true);
    expect(init.params.message.result.hostContext.styles.variables).toEqual({ "--sf-ground": "#111111" });
    expect(JSON.stringify(init)).not.toMatch(/secret-token|Bearer/);
    emit(win, {
      jsonrpc: "2.0",
      method: "sf/sandbox-relay",
      params: { nonce, message: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 40 } } },
    });
    expect(iframe.style.height).toBe("200px");
    emit(win, {
      jsonrpc: "2.0",
      method: "sf/sandbox-relay",
      params: { nonce, message: { jsonrpc: "2.0", method: "ui/notifications/link-blocked", params: { href: "https://evil.example/out" } } },
    });
    expect(container?.textContent).toContain("A link in this artifact was blocked");
    expect(container?.textContent).not.toContain("https://evil.example/out");
    expect(location.href).not.toContain("evil.example");
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container?.textContent).not.toContain("A link in this artifact was blocked");
  });

  it("shows a sandbox error and recreates the frame on retry and on html change", async () => {
    vi.useFakeTimers();
    setSandboxOriginForTests(ORIGIN);
    await render(createElement(LiveHtmlFrame, props()));
    const first = shell();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container?.textContent).toContain("The sandbox did not start");
    expect(container?.textContent).toContain(ORIGIN);
    await act(async () => {
      container?.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const second = shell();
    expect(second.iframe).not.toBe(first.iframe);
    emit(second.win, ready());
    const firstLoad = second.post.mock.calls.find((call) => (call[0] as { method?: string }).method === "sf/sandbox-load");
    const firstNonce = (firstLoad?.[0] as { params: { nonce: string } }).params.nonce;
    await act(async () => {
      root?.render(createElement(LiveHtmlFrame, props({ html: "<p>Next</p>" })));
    });
    const third = shell();
    emit(third.win, ready());
    const nextLoad = third.post.mock.calls.find((call) => (call[0] as { method?: string }).method === "sf/sandbox-load");
    expect((nextLoad?.[0] as { params: { html: string; nonce: string } }).params.html).toBe("<p>Next</p>");
    expect((nextLoad?.[0] as { params: { nonce: string } }).params.nonce).not.toBe(firstNonce);
  });

  it("removes the listener on unmount", async () => {
    setSandboxOriginForTests(ORIGIN);
    await render(createElement(LiveHtmlFrame, props()));
    const { win, post } = shell();
    await act(async () => {
      root?.unmount();
    });
    root = null;
    emit(win, ready());
    expect(post).not.toHaveBeenCalled();
  });

  it("sends one load under StrictMode", async () => {
    setSandboxOriginForTests(ORIGIN);
    await render(createElement(StrictMode, null, createElement(LiveHtmlFrame, props())));
    expect(container?.querySelectorAll("[data-testid=live-html-shell]")).toHaveLength(1);
    const { win, post } = shell();
    emit(win, ready());
    emit(win, ready());
    expect(post.mock.calls.filter((call) => (call[0] as { method?: string }).method === "sf/sandbox-load")).toHaveLength(1);
  });

  it("shows a card when the shell stops the artifact and ignores later messages", async () => {
    const cases: Array<[unknown, string, string]> = [
      ["navigated", "This artifact tried to navigate away and was stopped for your safety.", "navigated"],
      ["csp", "The sandbox refused this artifact's security policy (this is a bug: please report it).", "csp"],
      ["nope", "The sandbox stopped this artifact.", "nope"],
      [{ unexpected: true }, "The sandbox stopped this artifact.", "unknown"],
    ];
    for (const [reason, text, detail] of cases) {
      act(() => {
        root?.unmount();
      });
      container?.remove();
      root = null;
      container = null;
      setSandboxOriginForTests(ORIGIN);
      const view = await render(createElement(LiveHtmlFrame, props()));
      const current = shell();
      emit(current.win, ready());
      const load = current.post.mock.calls.find((call) => (call[0] as { method?: string }).method === "sf/sandbox-load");
      const nonce = (load?.[0] as { params: { nonce: string } }).params.nonce;
      current.post.mockClear();
      emit(current.win, { jsonrpc: "2.0", method: "sf/sandbox-error", params: { reason } });
      expect(view.querySelector("[role=alert]")?.textContent).toContain(text);
      const details = view.querySelector("details");
      expect(details?.hasAttribute("open")).toBe(false);
      expect(details?.textContent).toContain(detail);
      expect(details?.textContent).toContain(ORIGIN);
      const frame = view.querySelector("[data-testid=live-html-shell]") as HTMLIFrameElement | null;
      expect(frame?.getAttribute("data-collapsed")).toBe("true");
      expect(frame?.style.height).toBe("48px");
      expect(frame?.className).not.toContain("min-h-[480px]");
      emit(current.win, ready());
      emit(current.win, {
        jsonrpc: "2.0",
        method: "sf/sandbox-relay",
        params: { nonce, message: { jsonrpc: "2.0", id: 1, method: "ping" } },
      });
      expect(current.post).not.toHaveBeenCalled();
      await act(async () => {
        view.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      const next = shell();
      expect(next.iframe).not.toBe(current.iframe);
      emit(next.win, ready());
      const nextLoad = next.post.mock.calls.find((call) => (call[0] as { method?: string }).method === "sf/sandbox-load");
      expect((nextLoad?.[0] as { params: { nonce: string } }).params.nonce).not.toBe(nonce);
      expect(view.querySelector("[role=alert]")).toBeNull();
    }
  });

  it("drops the ready timer when the frame is recreated", async () => {
    vi.useFakeTimers();
    setSandboxOriginForTests(ORIGIN);
    await render(createElement(LiveHtmlFrame, props()));
    await act(async () => {
      vi.advanceTimersByTime(4_000);
      root?.render(createElement(LiveHtmlFrame, props({ html: "<p>Next</p>" })));
    });
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container?.textContent).not.toContain("The sandbox did not start");
    const next = shell();
    emit(next.win, ready());
    expect(next.post.mock.calls.some((call) => (call[0] as { method?: string }).method === "sf/sandbox-load")).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container?.textContent).not.toContain("The sandbox did not start");
  });

  it("waits for the first snapshot, pushes a change once, and stops the wait on unmount", async () => {
    vi.useFakeTimers();
    setSandboxOriginForTests(ORIGIN);
    const initial = props({ snapshots: [], settled: false, refreshing: true });
    await render(createElement(LiveHtmlFrame, initial));
    const { win, post } = shell();
    emit(win, ready());
    const load = post.mock.calls.find((call) => (call[0] as { method?: string }).method === "sf/sandbox-load");
    const nonce = (load?.[0] as { params: { nonce: string } }).params.nonce;
    post.mockClear();
    emit(win, {
      jsonrpc: "2.0",
      method: "sf/sandbox-relay",
      params: { nonce, message: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rows" } } },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(post).not.toHaveBeenCalled();
    await act(async () => {
      root?.render(createElement(LiveHtmlFrame, props({
        snapshots: [snap({ weeks: 12 })],
        settled: true,
        refreshing: false,
      })));
      await Promise.resolve();
      await Promise.resolve();
    });
    const result = post.mock.calls
      .map((call) => call[0] as { method?: string; params?: { nonce?: string; message?: { id?: number; result?: { structuredContent?: unknown; isError?: boolean } } } })
      .find((message) => message.params?.message?.id === 3);
    expect(result?.method).toBe("sf/sandbox-relay");
    expect(result?.params?.nonce).toBe(nonce);
    expect(result?.params?.message?.result?.structuredContent).toEqual({ weeks: 12 });
    const updates = post.mock.calls
      .map((call) => call[0] as { method?: string; params?: { nonce?: string; message?: { method?: string; params?: { binding_id?: string } } } })
      .filter((message) => message.params?.message?.method === "ui/notifications/binding-updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.params?.nonce).toBe(nonce);
    expect(updates[0]?.params?.message?.params).toEqual({ binding_id: "rows" });
    expect(post.mock.calls.every((call) => call[1] === ORIGIN)).toBe(true);
    post.mockClear();
    await act(async () => {
      root?.render(createElement(LiveHtmlFrame, props({
        snapshots: [snap({ weeks: 12 })],
        settled: true,
        refreshing: false,
      })));
    });
    expect(post).not.toHaveBeenCalled();
    await act(async () => {
      root?.render(createElement(LiveHtmlFrame, props({
        snapshots: [{ ...snap({ weeks: 12 }), fetched_at: "2026-11-25T02:00:00.000Z" }],
        settled: true,
        refreshing: false,
      })));
    });
    expect(post).not.toHaveBeenCalled();
    await act(async () => {
      root?.render(createElement(LiveHtmlFrame, props({
        snapshots: [snap({ weeks: 4 })],
        settled: true,
        refreshing: false,
      })));
    });
    const changed = post.mock.calls.filter((call) => {
      const message = call[0] as { params?: { message?: { method?: string } } };
      return message.params?.message?.method === "ui/notifications/binding-updated";
    });
    expect(changed).toHaveLength(1);

    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    await render(createElement(LiveHtmlFrame, props({ snapshots: [], settled: false, refreshing: true })));
    const waiting = shell();
    emit(waiting.win, ready());
    const waitingLoad = waiting.post.mock.calls.find((call) => (call[0] as { method?: string }).method === "sf/sandbox-load");
    const waitingNonce = (waitingLoad?.[0] as { params: { nonce: string } }).params.nonce;
    waiting.post.mockClear();
    emit(waiting.win, {
      jsonrpc: "2.0",
      method: "sf/sandbox-relay",
      params: { nonce: waitingNonce, message: { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "rows" } } },
    });
    await act(async () => {
      root?.unmount();
      vi.advanceTimersByTime(10_000);
    });
    root = null;
    expect(waiting.post).not.toHaveBeenCalled();
  });

  it("answers a failed refresh with a retryable error and does not push an unchanged value", async () => {
    setSandboxOriginForTests(ORIGIN);
    await render(createElement(LiveHtmlFrame, props({ snapshots: [], settled: false, refreshing: true })));
    const { win, post } = shell();
    emit(win, ready());
    const load = post.mock.calls.find((call) => (call[0] as { method?: string }).method === "sf/sandbox-load");
    const nonce = (load?.[0] as { params: { nonce: string } }).params.nonce;
    post.mockClear();
    emit(win, {
      jsonrpc: "2.0",
      method: "sf/sandbox-relay",
      params: { nonce, message: { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rows", arguments: { weeks: 12 } } } },
    });
    await act(async () => {
      root?.render(createElement(LiveHtmlFrame, props({ snapshots: [], settled: true, refreshing: false })));
      await Promise.resolve();
      await Promise.resolve();
    });
    const result = post.mock.calls
      .map((call) => call[0] as { params?: { nonce?: string; message?: { id?: number; result?: { isError?: boolean; _meta?: { retryable?: boolean }; content?: Array<{ text?: string }> } } } })
      .find((message) => message.params?.message?.id === 5);
    expect(result?.params?.nonce).toBe(nonce);
    expect(result?.params?.message?.result).toMatchObject({
      isError: true,
      content: [{ text: "no data yet" }],
      _meta: { retryable: true },
    });
    expect(post.mock.calls.some((call) => {
      const message = call[0] as { params?: { message?: { method?: string } } };
      return message.params?.message?.method === "ui/notifications/binding-updated";
    })).toBe(false);
  });

  it("loads the live html chunk from the detail page", async () => {
    setSandboxOriginForTests(ORIGIN);
    const rec = record();
    await render(createElement(ArtifactDetailView, {
      meta: artifactDetailMeta(rec),
      preview: { mode: "html", text: "<p>Hi</p>" },
      onBack: () => undefined,
      live: rec.live,
      liveHtml: props(),
      historicalSnapshots: true,
    }));
    expect(container?.textContent).toContain("HTML source");
    expect(container?.textContent).toContain("Snapshots are for the current version.");
    expect(container?.textContent).toContain("Declared origins");
    expect(container?.textContent).toContain("https://api.example.com");
    await act(async () => {
      await Promise.resolve();
    });
    expect(container?.querySelector("[data-testid=live-html-shell]")).toBeTruthy();
  });

  it("reports library and html fetch failures", async () => {
    setSandboxOriginForTests(ORIGIN);
    await render(createElement(LiveHtmlFrame, props({
      record: record({ live: { status: "fresh", format: "openui-lang", bindings: [] } }),
    })));
    expect(container?.textContent).toContain("Library n/a");
    await act(async () => {
      root?.render(createElement(LiveHtmlFrame, props({ html: null, htmlError: "missing file" })));
    });
    expect(container?.textContent).toContain("Could not load the HTML");
    expect(container?.textContent).toContain("missing file");
  });
});

describe("sandbox origin hook", () => {
  it("follows health across a reconnect", async () => {
    let health: CapacityHealth | null = null;
    const catalog = createRunCatalog({
      source: {
        readListing: async () => ({ runs: [] }),
        readCapacity: async () => {
          if (!health) throw new Error("down");
          return health;
        },
      },
      intervalMs: 60_000,
    });
    function Probe() {
      const state = useSandboxOrigin();
      return createElement("div", { "data-ready": String(state.ready), "data-origin": state.origin ?? "" });
    }
    await render(createElement(RunCatalogProvider, { catalog, children: createElement(Probe) }));
    await act(async () => {
      await catalog.start();
    });
    expect(container?.querySelector("[data-ready]")?.getAttribute("data-ready")).toBe("true");
    expect(container?.querySelector("[data-origin]")?.getAttribute("data-origin")).toBe("");
    health = { ok: true, activeRunIds: [], activeCount: 0, maxConcurrent: 1, slotsAvailable: 1, queuedCount: 0, sandbox_origin: ORIGIN };
    await act(async () => {
      await catalog.refresh();
    });
    expect(container?.querySelector("[data-origin]")?.getAttribute("data-origin")).toBe(ORIGIN);
    health = {
      ...health,
      sandbox_origin: ORIGIN,
      sandbox_origins: [ORIGIN, "http://127.0.0.1:5999"],
    };
    await act(async () => {
      await catalog.refresh();
    });
    const other = location.hostname === "127.0.0.1" ? ORIGIN : "http://127.0.0.1:5999";
    expect(container?.querySelector("[data-origin]")?.getAttribute("data-origin")).toBe(other);
    health = { ...health, sandbox_origin: null, sandbox_origins: [] };
    await act(async () => {
      await catalog.refresh();
    });
    expect(container?.querySelector("[data-origin]")?.getAttribute("data-origin")).toBe("");
    catalog.stop();
  });
});
